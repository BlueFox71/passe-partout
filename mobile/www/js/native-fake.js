// Natif simulé (aperçu dans le navigateur et tests Node) : même interface que PPM.native.
// Aucune sécurité réelle : le « Keystore » n'est qu'un marquage réversible des octets.
//
// Fabrique : PPM.nativeFake.create({store}) → instance indépendante ; `store` suit l'interface de
// localStorage (getItem/setItem/removeItem). Deux instances sur le même `store` partagent fichiers,
// préférences et clés (simule un redémarrage de l'appli). Sans `store` : localStorage s'il existe,
// sinon PPM.nativeFake.memoryStore() (mémoire). PPM.nativeFake est lui-même une instance par défaut.
// Commandes de test : setBiometricError(code|null), setUnwrapError(code|null), setBiometricAvailable(bool),
// setNextQr(texte), firePause(), fireResume(), fireBack() ; `clipboard` = dernière copie {text, sensitive, seconds}.
// inNativeScreen() : vrai pendant un écran natif lancé par l'appli (scanner, empreinte), comme le natif réel
// (Ruling 23 : ces écrans ne comptent pas comme arrière-plan pour le verrouillage à 30 s).
// Codes d'erreur de unwrap, comme le natif réel : KEY_MISSING (clé absente ou effacée), BAD_BLOB (blob mal
// formé ou d'une autre clé), KEY_INVALIDATED, CANCELED, LOCKOUT (trop d'essais d'empreinte), FAILED.
// simulatePc({code, vault, lockMode, pinLength, pcName}) : PC simulé (aperçu et tests uniquement) ; scanQr
// renvoie alors un nouveau QR de ce PC et post() lui répond comme app/syncflow.py (voir simulatedPc).
(function (root) {
  const FILE = "pp.fake.file:";
  const PREF = "pp.fake.pref:";
  const KEY = "pp.fake.key:";
  const BLOB = "fake-keystore:";

  function b64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hex(n) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function nativeError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  function memoryStore() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  }

  function defaultStore() {
    try {
      // seulement dans un navigateur : Node peut exposer un localStorage expérimental
      if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
    } catch (e) { /* stockage bloqué : mémoire */ }
    return memoryStore();
  }

  // Blob : « fake-keystore:<alias>:<id de clé>:<bio 0|1>:<base64> ».
  function parseBlob(blob) {
    const m = /^fake-keystore:([^:]+):([0-9a-f]+):([01]):(.*)$/.exec(String(blob));
    return m ? { alias: m[1], keyId: m[2], bio: m[3] === "1", data: m[4] } : null;
  }

  function isFakeBlob(blob, alias) {
    const p = parseBlob(blob);
    return !!p && (alias == null || p.alias === alias);
  }

  function create({ store } = {}) {
    store = store || defaultStore();
    const pauseCbs = [];
    const resumeCbs = [];
    const backCbs = [];
    let bioError = null;
    let unwrapError = null;
    let bioAvailable = true;
    let nextQr = null;
    let simPc = null;
    let screens = 0; // écrans natifs ouverts par l'appli

    // Exécute fn pendant un « écran natif » (le compteur couvre toute la durée de l'appel).
    async function onScreen(fn) {
      screens++;
      try {
        return await fn();
      } finally {
        screens--;
      }
    }

    // Clé « Keystore » par alias, créée à la demande ; deleteKey la détruit (anciens blobs illisibles).
    function keyId(alias, createIt) {
      let id = store.getItem(KEY + alias);
      if (!id && createIt) {
        id = hex(8);
        store.setItem(KEY + alias, id);
      }
      return id;
    }

    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", () => (document.hidden ? fake.firePause() : fake.fireResume()));
    }

    const fake = {
      store,
      clipboard: null,

      wrap(alias, bytes, { biometric = false } = {}) {
        const run = async () => {
          if (biometric) {
            if (!bioAvailable) throw nativeError("FAILED", "Empreinte indisponible");
            if (bioError) throw nativeError(bioError);
          }
          return `${BLOB}${alias}:${keyId(alias, true)}:${biometric ? 1 : 0}:${b64(bytes)}`;
        };
        return biometric ? onScreen(run) : run(); // invite d'empreinte
      },

      unwrap(alias, blob, { title } = {}) { // eslint-disable-line no-unused-vars
        const p = parseBlob(blob);
        const run = async () => {
          if (unwrapError) throw nativeError(unwrapError);
          if (!p || p.alias !== alias) throw nativeError("BAD_BLOB");
          const id = keyId(alias, false);
          if (!id) throw nativeError("KEY_MISSING");
          if (p.keyId !== id) throw nativeError("BAD_BLOB"); // clé recréée depuis : blob illisible
          if (p.bio && bioError) throw nativeError(bioError);
          return unb64(p.data);
        };
        return p && p.bio ? onScreen(run) : run(); // clé à empreinte : invite d'empreinte
      },

      inNativeScreen() { return screens > 0; },

      async deleteKey(alias) {
        store.removeItem(KEY + alias);
        if (bioError === "KEY_INVALIDATED") bioError = null; // nouvelle clé : de nouveau utilisable
      },

      async biometricAvailable() { return bioAvailable; },

      async copySensitive(text, seconds = 30) {
        fake.clipboard = { text: String(text), sensitive: true, seconds };
        await browserCopy(text);
      },

      async copyPlain(text) {
        fake.clipboard = { text: String(text), sensitive: false, seconds: null };
        await browserCopy(text);
      },

      async readFile(name) { return store.getItem(FILE + name); },
      async writeFileAtomic(name, text) { store.setItem(FILE + name, String(text)); },
      async removeFile(name) { store.removeItem(FILE + name); },

      async getPref(key) {
        const raw = store.getItem(PREF + key);
        if (raw == null) return null;
        try { return JSON.parse(raw); } catch (e) { return null; }
      },
      async setPref(key, value) { store.setItem(PREF + key, JSON.stringify(value)); },

      async deviceName() { return "Aperçu navigateur"; },

      onPause(cb) { pauseCbs.push(cb); },
      onResume(cb) { resumeCbs.push(cb); },
      firePause() { pauseCbs.forEach((cb) => cb()); },
      fireResume() { resumeCbs.forEach((cb) => cb()); },
      // Bouton retour (Android) : rappels essayés du dernier au premier ; faux si aucun ne l'a traité
      // (le vrai natif mettrait alors l'appli en arrière-plan).
      onBack(cb) { backCbs.push(cb); },
      async fireBack() {
        for (let i = backCbs.length - 1; i >= 0; i--) if (await backCbs[i]()) return true;
        return false;
      },

      // Dans le navigateur : texte du QR saisi dans une fenêtre PP.modal ; ailleurs, valeur de setNextQr.
      scanQr() {
        return onScreen(async () => {
          if (nextQr !== null) {
            const t = nextQr;
            nextQr = null;
            return t;
          }
          if (simPc) return simPc.newQr();
          const PP = root.PP;
          if (!PP || !PP.modal || typeof document === "undefined") return null;
          return askQr(PP);
        });
      },

      async post(url, body, timeoutMs) {
        if (simPc && simPc.owns(url)) return simPc.post(url, body);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const r = await fetch(url, {
            method: "POST", body, signal: ctrl.signal, headers: { "Content-Type": "application/json" },
          });
          return { status: r.status, text: await r.text() };
        } finally {
          clearTimeout(timer);
        }
      },

      setBiometricError(code) { bioError = code || null; },
      setUnwrapError(code) { unwrapError = code || null; },
      setBiometricAvailable(v) { bioAvailable = Boolean(v); },
      setNextQr(text) { nextQr = text == null ? null : String(text); },
      simulatePc(opts) { simPc = simulatedPc(opts); return simPc; },
    };
    return fake;
  }

  // ---------------------------------------------------------------- PC simulé (aperçu, tests)
  // Imite app/sync.py + app/syncflow.py pour le parcours normal : session à usage unique par QR, un seul
  // hello, code exigé (appareil inconnu ou sans preuve d'appairage valide, code changé, restauration),
// appairage comme le PC (secret par appareil après une synchro avec code, preuves HMAC, Ruling 21),
// remplacement au premier lancement, sinon fusion
  // simplifiée (le plus récent gagne, pierres tombales appliquées). Pas de contrôle d'heure ; délai
  // anti-essais simplifié (30 s après 3 codes faux). Aucune sécurité : jamais utilisé sur un vrai téléphone.
  const SIM_HOSTS = ["172.31.240.1", "192.168.1.42"]; // le 1er imite un adaptateur virtuel qui ne répond pas
  const SIM_PORT = 47823;
  const SIM_KINDS = { profiles: "profile", accounts: "account", giftcards: "giftcard" };
  const SIM_INVALID = "Message de synchronisation invalide.";

  function simulatedPc({ code, vault, lockMode = "pin", pinLength, pcName = "PC simulé" } = {}) {
    const C = root.PPM && root.PPM.crypto ? root.PPM.crypto : require("./crypto.js");
    const clone = (x) => JSON.parse(JSON.stringify(x));
    let pcVault = { profiles: [], accounts: [], giftcards: [], deleted: [], ...clone(vault || {}) };
    delete pcVault.version;
    let pcCode = String(code);
    let codeVersion = hex(8);
    let generation = hex(8);
    const devices = new Map(); // device_id → secret d'appairage (base64url)
    const log = []; // messages reçus : {type, code, vault} (présence seulement), pour les tests
    let fails = 0;
    let blockedUntil = 0;
    let session = null; // {key, hello, state, seen}
    const refuse = (error, message, extra = {}) => ({ ok: false, error, message, ...extra });
    const lockInfo = () => ({
      lock_mode: lockMode, pin_length: lockMode === "pin" ? (pinLength || pcCode.length) : null,
    });

    async function hello(msg) {
      if (session.hello) return refuse("invalid", SIM_INVALID);
      const pair = devices.get(msg.device_id);
      let proven = false;
      if (pair && typeof msg.proof === "string" && msg.proof) {
        proven = C.sameText(msg.proof, await C.pairProof(C.unb64u(pair), session.key, C.PROOF_PHONE));
      }
      const needCode = !proven || msg.code_version !== codeVersion || msg.generation !== generation;
      let mode = "merge";
      let reason = null;
      if (!msg.has_data) [mode, reason] = ["replace", "first"];
      else if (msg.generation !== generation) [mode, reason] = ["replace", "restored"];
      else if (!msg.last_sync) [mode, reason] = ["replace", "stale"];
      session.hello = { device_id: msg.device_id, need_code: needCode, mode, last_sync: msg.last_sync ?? null };
      const reply = { ok: true, pc: pcName, ...lockInfo(), need_code: needCode, mode, reason,
        since: msg.last_sync ?? null };
      if (proven) reply.proof_pc = await C.pairProof(C.unb64u(pair), session.key, C.PROOF_PC);
      if (!needCode) reply.code_version = codeVersion;
      return reply;
    }

    function merge(phone) {
      const out = { profiles: [], accounts: [], giftcards: [], deleted: [] };
      const summary = { to_pc: 0, to_phone: 0, deleted: 0, conflicts: 0 };
      const tomb = new Map();
      for (const t of [...pcVault.deleted, ...(phone.deleted || [])]) tomb.set(`${t.kind}:${t.id}`, t);
      out.deleted = [...tomb.values()];
      for (const [list, kind] of Object.entries(SIM_KINDS)) {
        const byId = new Map();
        for (const it of pcVault[list]) byId.set(it.id, { pc: it });
        for (const it of phone[list] || []) byId.set(it.id, { ...byId.get(it.id), phone: it });
        for (const [id, { pc, phone: ph }] of byId) {
          if (tomb.has(`${kind}:${id}`)) {
            summary.deleted++;
            continue;
          }
          const phoneWins = !!ph && (!pc || ph.updated > pc.updated);
          if (phoneWins) summary.to_pc++;
          else if (!ph || JSON.stringify(ph) !== JSON.stringify(pc)) summary.to_phone++;
          out[list].push(phoneWins ? ph : pc);
        }
      }
      return { vault: out, summary };
    }

    function sync(msg) {
      const h = session.hello;
      if (!h || msg.device_id !== h.device_id || msg.replace !== (h.mode === "replace")
        || (msg.last_sync ?? null) !== h.last_sync) {
        return refuse("invalid", SIM_INVALID);
      }
      if (h.need_code) {
        if (typeof msg.code !== "string" || !msg.code) return refuse("code_required", "Saisis le code du PC.");
        const wait = Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
        if (wait > 0) return refuse("bad_code", "Code incorrect.", { wait_seconds: wait });
        if (msg.code !== pcCode) {
          fails++;
          if (fails >= 3) blockedUntil = Date.now() + 30000;
          return refuse("bad_code", "Code incorrect.", { wait_seconds: fails >= 3 ? 30 : 0 });
        }
        fails = 0;
      }
      let summary;
      if (msg.replace) {
        const items = pcVault.profiles.length + pcVault.accounts.length + pcVault.giftcards.length;
        summary = { to_pc: 0, to_phone: items, deleted: 0, conflicts: 0 };
      } else {
        const m = merge(msg.vault || {});
        pcVault = m.vault;
        summary = m.summary;
      }
      const newPair = h.need_code ? C.b64u(C.randomBytes(32)) : null; // nouveau secret après le code
      devices.set(h.device_id, newPair || devices.get(h.device_id));
      session.state = "done";
      const reply = { ok: true, vault: { version: 1, ...clone(pcVault) }, summary, code_version: codeVersion,
        generation, synced_at: msg.now, ...lockInfo() };
      if (newPair) reply.pair = newPair;
      return reply;
    }

    async function handle(msg) {
      log.push({ type: msg.type, code: msg.code != null, vault: msg.vault != null });
      if (msg.type === "cancel") {
        session.state = "closed";
        return { ok: true };
      }
      if (msg.type === "hello") return hello(msg);
      if (msg.type === "sync") return sync(msg);
      return refuse("invalid", SIM_INVALID);
    }

    return {
      get vault() { return clone(pcVault); },
      get log() { return log.slice(); },
      // « Oublier ce téléphone » sur le PC : appareil et secret effacés
      forget(deviceId) { devices.delete(deviceId); },
      // restauration d'une sauvegarde : nouvelle génération (le registre restauré garde les secrets)
      restore() { generation = hex(8); },
      // nouveau QR = nouvelle session (l'ancienne est abandonnée, comme sur le PC)
      newQr() {
        const key = C.randomBytes(32);
        session = { key, hello: null, state: "waiting", seen: new Set() };
        return JSON.stringify({ v: 1, hosts: SIM_HOSTS, port: SIM_PORT, key: C.b64u(key), pc: pcName });
      },
      owns(url) { return SIM_HOSTS.some((h) => String(url).startsWith(`http://${h}:${SIM_PORT}/`)); },
      async post(url, body) {
        if (!String(url).startsWith(`http://${SIM_HOSTS[1]}:`)) throw new Error("injoignable");
        if (!session || session.state !== "waiting") return { status: 410, text: "" };
        let msg;
        try {
          msg = await C.open(session.key, body, C.AAD_REQ);
        } catch (e) {
          return { status: 403, text: "" };
        }
        const n = JSON.parse(body).n;
        if (session.seen.has(n)) return { status: 409, text: "" };
        session.seen.add(n);
        const reply = await handle(msg);
        return { status: 200, text: await C.seal(session.key, reply, C.AAD_RESP) };
      },
      setCode(newCode) {
        pcCode = String(newCode);
        codeVersion = hex(8);
      },
      lock() { if (session) session.state = "closed"; }, // le PC arrête la synchro en se verrouillant
    };
  }


  async function browserCopy(text) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) await navigator.clipboard.writeText(String(text));
    } catch (e) { /* presse-papiers refusé dans l'aperçu : sans importance */ }
  }

  function askQr(PP) {
    return new Promise((resolve) => {
      let done = false;
      const m = PP.modal.open(
        `<h2>Scanner le QR code (aperçu)</h2>
         <p style="color:var(--muted);margin:0 0 8px">Colle le texte du QR code affiché par le PC.</p>
         <textarea class="input" rows="4" style="width:100%"></textarea>
         <div class="modal-foot"><button class="btn btn-ghost" data-r="0">Annuler</button>
         <button class="btn btn-primary" data-r="1">Valider</button></div>`,
        { cls: "sm", onClose: () => { if (!done) resolve(null); } }
      );
      m.querySelectorAll("[data-r]").forEach((b) =>
        b.addEventListener("click", () => {
          done = true;
          const t = m.querySelector("textarea").value.trim();
          PP.modal.close();
          resolve(b.dataset.r === "1" && t ? t : null);
        })
      );
    });
  }

  const instance = create();
  instance.create = create;
  instance.memoryStore = memoryStore;
  instance.isFakeBlob = isFakeBlob;

  root.PPM = root.PPM || {};
  root.PPM.nativeFake = instance;
  if (typeof module === "object") module.exports = instance;
})(typeof window !== "undefined" ? window : globalThis);
