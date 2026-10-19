// Client de synchro du téléphone : lecture du QR code du PC, messages « hello » / « sync » / « cancel »
// chiffrés avec la clé du QR (enveloppe de app/sync.py), essai des adresses du PC dans l'ordre.
// Erreurs de transport : Error avec .code « unreachable », « expired », « forbidden », « invalid » ou
// « unpaired » (PC qui ne prouve pas l'appairage, Ruling 21) et un message à afficher tel quel. Une erreur du PC ({"ok": false, …}) est renvoyée comme réponse, sauf
// « closed » (PC verrouillé pendant l'échange) traitée comme un QR expiré. Rien n'est journalisé.
// Version de l'appli (Tâche 4 côté PC) : hello lève « update_required » (Error.details = {current, available,
// size, sha256, message}) ou « pc_outdated » (message du PC) ; la session reste ouverte et downloadApk()
// demande l'APK (« apk »), vérifié par SHA-256 (sinon « apk_corrupt »). Jamais de second hello sur le même QR.
(function (root) {
  const PPM = (root.PPM = root.PPM || {});
  if (typeof module === "object" && typeof require === "function" && !PPM.crypto) require("./crypto.js");

  const PATH = "/pp-sync";
  const SYNC_TIMEOUT_MS = 30000; // la réponse de sync peut porter tout le coffre et une vérification de code
  const APK_TIMEOUT_MS = 60000; // l'APK chiffré fait ~20 Mo
  const HEX64 = /^[0-9a-f]{64}$/;

  const MESSAGES = {
    foreign: "Ce QR code ne vient pas de Passe-Partout.",
    unreachable: "PC injoignable : vérifie que le téléphone est sur le même Wi-Fi et que le pare-feu Windows autorise Passe-Partout.",
    too_large: "Données trop volumineuses ou PC injoignable : vérifie le Wi-Fi puis réessaie.",
    expired: "QR code expiré : relance la synchronisation sur le PC.",
    forbidden: "QR code refusé par le PC.",
    invalid: "Réponse du PC incompréhensible : mets à jour Passe-Partout sur le PC et sur le téléphone.",
    apk_corrupt: "La mise à jour reçue est abîmée : relance la synchronisation.",
    no_update: "Aucune mise à jour à télécharger : relance la synchronisation.",
    pc_outdated: "Mets à jour Passe-Partout sur le PC (Le Grenier).",
    update_required: "Mets à jour l'appli : sur le PC, Réglages → Installer l'appli sur le téléphone.",
    unpaired: "Ce QR code ne vient pas de ton PC (appairage non reconnu). Si tu as réinstallé ou oublié ce "
      + "téléphone sur le PC, choisis « Ré-appairer » : le code du PC te sera demandé.",
  };

  function syncError(code, message = MESSAGES[code]) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
  const strOrNull = (x) => (typeof x === "string" && x ? x : null);

  function hex(bytes) {
    let s = "";
    for (const b of bytes) s += (b < 16 ? "0" : "") + b.toString(16);
    return s;
  }

  // Refus de version du PC → Error codée (hello). `details` pour update_required.
  function versionError(reply) {
    const message = strOrNull(reply.message) || MESSAGES[reply.error];
    const e = syncError(reply.error, message);
    if (reply.error === "update_required") {
      const sha = typeof reply.sha256 === "string" ? reply.sha256.toLowerCase() : null;
      e.details = {
        current: strOrNull(reply.current),
        available: strOrNull(reply.available),
        size: Number.isSafeInteger(reply.size) && reply.size > 0 ? reply.size : null,
        sha256: sha && HEX64.test(sha) ? sha : null, // sans empreinte : pas d'APK sur le PC
        message,
      };
    }
    return e;
  }

  // {"v":1,"hosts":[…],"port":N,"key":b64url(32 octets),"pc":"<nom>"} → {hosts, port, key, pc}
  function parseQr(text) {
    const foreign = () => syncError("foreign");
    let d;
    try {
      d = JSON.parse(String(text));
    } catch (e) {
      throw foreign();
    }
    if (!isObj(d) || d.v !== 1) throw foreign();
    const hosts = d.hosts;
    if (!Array.isArray(hosts) || !hosts.length || !hosts.every((h) => typeof h === "string" && h)) throw foreign();
    if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) throw foreign();
    let key;
    try {
      key = PPM.crypto.unb64u(d.key);
    } catch (e) {
      throw foreign();
    }
    if (typeof d.key !== "string" || key.length !== 32) throw foreign();
    const pc = typeof d.pc === "string" && d.pc.trim() ? d.pc.trim() : "PC";
    return { hosts: hosts.slice(), port: d.port, key, pc };
  }

  // Message « sync » (sans le type) : last_sync et device_id repris de l'info envoyée au hello,
  // remplacement si le hello l'a annoncé, coffre du téléphone seulement en fusion.
  function syncMessage(info, hello, { vault = null, code = null, now = info.now } = {}) {
    const replace = hello.mode === "replace";
    const msg = {
      device_id: info.device_id, device_name: info.device_name, replace, last_sync: info.last_sync ?? null,
      now, code: typeof code === "string" && code ? code : null,
    };
    if (!replace) msg.vault = vault;
    return msg;
  }

  class SyncClient {
    constructor({ qr, post, crypto = PPM.crypto, timeoutMs = 3000, syncTimeoutMs = SYNC_TIMEOUT_MS }) {
      this._qr = qr;
      this._post = post;
      this._crypto = crypto;
      this._timeoutMs = timeoutMs;
      this._syncTimeoutMs = Math.max(timeoutMs, syncTimeoutMs);
      this._host = null; // adresse qui a répondu au hello
      this._hello = null;
      this._blocked = null; // Error update_required / pc_outdated du hello (session gardée pour « apk »)
    }

    get hello_reply() {
      return this._hello;
    }

    _url(host) {
      const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; // IPv6
      return `http://${h}:${this._qr.port}${PATH}`;
    }

    // Envoie un message chiffré à une adresse ; réponse déchiffrée (objet) ou Error codée.
    async _send(host, msg, timeoutMs) {
      const C = this._crypto;
      const body = await C.seal(this._qr.key, msg, C.AAD_REQ);
      let res;
      try {
        res = await this._post(this._url(host), body, timeoutMs);
      } catch (e) {
        throw syncError("unreachable");
      }
      const status = res && res.status;
      if (status === 410) throw syncError("expired");
      if (status === 403 || status === 409) throw syncError("forbidden");
      if (status === 413) throw syncError("unreachable", MESSAGES.too_large);
      if (status !== 200) throw syncError("unreachable");
      let reply;
      try {
        reply = await C.open(this._qr.key, res.text, C.AAD_RESP);
      } catch (e) {
        throw syncError("forbidden"); // pas chiffré avec la clé du QR : ce n'est pas notre PC
      }
      if (!isObj(reply)) throw syncError("forbidden");
      if (reply.ok === false && reply.error === "closed") throw syncError("expired");
      return reply;
    }

    // Un seul hello par session : s'il a déjà réussi, sa réponse est renvoyée sans nouvel envoi.
    // `pair` : secret d'appairage du téléphone (base64url) ou null ; jamais envoyé, seule la preuve part.
    // Téléphone appairé : une réponse sans preuve valide du PC lève « unpaired » AVANT tout code ou coffre.
    async hello(info, { pair = null } = {}) {
      if (this._hello) return this._hello;
      if (this._blocked) throw this._blocked; // le hello de ce QR a déjà servi
      const C = this._crypto;
      const msg = { type: "hello", ...info };
      delete msg.pair;
      delete msg.proof;
      let secret = null;
      if (typeof pair === "string" && pair) {
        secret = C.unb64u(pair);
        msg.proof = await C.pairProof(secret, this._qr.key, C.PROOF_PHONE);
      }
      const rank = { unreachable: 0, invalid: 1, forbidden: 2, expired: 3 };
      let worst = null;
      for (const host of this._qr.hosts) {
        let reply;
        try {
          reply = await this._send(host, msg, this._timeoutMs);
        } catch (e) {
          if (!worst || (rank[e.code] ?? 0) > (rank[worst.code] ?? 0)) worst = e;
          continue; // adaptateur virtuel (Hyper-V, WSL) ou autre machine : adresse suivante
        }
        if (reply.ok === true && (typeof reply.need_code !== "boolean" || !["replace", "merge"].includes(reply.mode))) {
          throw syncError("invalid");
        }
        if (reply.ok !== true && reply.ok !== false) throw syncError("invalid");
        this._host = host;
        if (reply.ok === false && (reply.error === "update_required" || reply.error === "pc_outdated")) {
          this._blocked = versionError(reply);
          throw this._blocked;
        }
        if (reply.ok === true && secret) {
          const expected = await C.pairProof(secret, this._qr.key, C.PROOF_PC);
          if (!C.sameText(reply.proof_pc, expected)) throw syncError("unpaired");
        }
        if (reply.ok === true) this._hello = reply;
        return reply;
      }
      throw worst || syncError("unreachable");
    }

    // Peut être renvoyé après une erreur du PC (code faux) : le hello n'est pas refait.
    async sync(payload) {
      if (!this._hello) throw new Error("hello d'abord");
      const reply = await this._send(this._host, { type: "sync", ...payload }, this._syncTimeoutMs);
      if (reply.ok !== true && reply.ok !== false) throw syncError("invalid");
      return reply;
    }

    // APK annoncé au hello (update_required) : octets vérifiés (empreinte du hello = empreinte reçue = SHA-256
    // calculé), sinon Error « apk_corrupt ». Peut être redemandé si le téléchargement a échoué.
    async downloadApk() {
      const d = this._blocked && this._blocked.details;
      if (!d || !d.sha256) throw syncError("no_update");
      const reply = await this._send(this._host, { type: "apk" }, APK_TIMEOUT_MS);
      if (reply.ok !== true) throw syncError("invalid", strOrNull(reply.message) || MESSAGES.invalid);
      if (typeof reply.apk !== "string" || typeof reply.sha256 !== "string") throw syncError("apk_corrupt");
      let bytes;
      try {
        bytes = this._crypto.unb64u(reply.apk);
      } catch (e) {
        throw syncError("apk_corrupt");
      }
      const digest = hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
      if (reply.sha256.toLowerCase() !== d.sha256 || digest !== d.sha256) throw syncError("apk_corrupt");
      return bytes;
    }

    // Prévient le PC que l'utilisateur abandonne ; jamais d'erreur.
    async cancel() {
      if (!this._host) return;
      try {
        await this._send(this._host, { type: "cancel" }, this._timeoutMs);
      } catch (e) { /* PC déjà fermé ou injoignable : rien à faire */ }
    }
  }

  // Compare deux versions « x.y.z » : -1, 0 ou 1 ; lève une erreur si l'une est invalide.
  function parseVersion(s) {
    const m = typeof s === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(s) : null;
    if (!m) throw new Error("version invalide : " + String(s));
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
    return 0;
  }

  const api = { parseQr, SyncClient, syncMessage, MESSAGES, compareVersions };
  PPM.parseQr = parseQr;
  PPM.SyncClient = SyncClient;
  PPM.syncMessage = syncMessage;
  PPM.syncMessages = MESSAGES;
  PPM.compareVersions = compareVersions;
  if (typeof module === "object") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
