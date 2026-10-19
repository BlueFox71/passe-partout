// Natif simulé (aperçu dans le navigateur et tests Node) : même interface que PPM.native.
// Aucune sécurité réelle : le « Keystore » n'est qu'un marquage réversible des octets.
//
// Fabrique : PPM.nativeFake.create({store}) → instance indépendante ; `store` suit l'interface de
// localStorage (getItem/setItem/removeItem). Deux instances sur le même `store` partagent fichiers,
// préférences et clés (simule un redémarrage de l'appli). Sans `store` : localStorage s'il existe,
// sinon PPM.nativeFake.memoryStore() (mémoire). PPM.nativeFake est lui-même une instance par défaut.
// Commandes de test : setBiometricError(code|null), setBiometricAvailable(bool), setNextQr(texte),
// firePause(), fireResume() ; `clipboard` = dernière copie {text, sensitive, seconds}.
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
    let bioError = null;
    let bioAvailable = true;
    let nextQr = null;

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

      async wrap(alias, bytes, { biometric = false } = {}) {
        if (biometric) {
          if (!bioAvailable) throw nativeError("FAILED", "Empreinte indisponible");
          if (bioError) throw nativeError(bioError);
        }
        return `${BLOB}${alias}:${keyId(alias, true)}:${biometric ? 1 : 0}:${b64(bytes)}`;
      },

      async unwrap(alias, blob, { title } = {}) { // eslint-disable-line no-unused-vars
        const p = parseBlob(blob);
        if (!p || p.alias !== alias || p.keyId !== keyId(alias, false)) throw nativeError("FAILED");
        if (p.bio && bioError) throw nativeError(bioError);
        return unb64(p.data);
      },

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

      // Dans le navigateur : texte du QR saisi dans une fenêtre PP.modal ; ailleurs, valeur de setNextQr.
      async scanQr() {
        if (nextQr !== null) {
          const t = nextQr;
          nextQr = null;
          return t;
        }
        const PP = root.PP;
        if (!PP || !PP.modal || typeof document === "undefined") return null;
        return askQr(PP);
      },

      async post(url, body, timeoutMs) {
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
      setBiometricAvailable(v) { bioAvailable = Boolean(v); },
      setNextQr(text) { nextQr = text == null ? null : String(text); },
    };
    return fake;
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
