// Client de synchro du téléphone : lecture du QR code du PC, messages « hello » / « sync » / « cancel »
// chiffrés avec la clé du QR (enveloppe de app/sync.py), essai des adresses du PC dans l'ordre.
// Erreurs de transport : Error avec .code « unreachable », « expired », « forbidden » ou « invalid » et un
// message à afficher tel quel. Une erreur du PC ({"ok": false, …}) est renvoyée comme réponse, sauf
// « closed » (PC verrouillé pendant l'échange) traitée comme un QR expiré. Rien n'est journalisé.
(function (root) {
  const PPM = (root.PPM = root.PPM || {});
  if (typeof module === "object" && typeof require === "function" && !PPM.crypto) require("./crypto.js");

  const PATH = "/pp-sync";
  const SYNC_TIMEOUT_MS = 30000; // la réponse de sync peut porter tout le coffre et une vérification de code

  const MESSAGES = {
    foreign: "Ce QR code ne vient pas de Passe-Partout.",
    unreachable: "PC injoignable : vérifie que le téléphone est sur le même Wi-Fi et que le pare-feu Windows autorise Passe-Partout.",
    too_large: "Données trop volumineuses ou PC injoignable : vérifie le Wi-Fi puis réessaie.",
    expired: "QR code expiré : relance la synchronisation sur le PC.",
    forbidden: "QR code refusé par le PC.",
    invalid: "Réponse du PC incompréhensible : mets à jour Passe-Partout sur le PC et sur le téléphone.",
  };

  function syncError(code, message = MESSAGES[code]) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

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
    async hello(info) {
      if (this._hello) return this._hello;
      const msg = { type: "hello", ...info };
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

    // Prévient le PC que l'utilisateur abandonne ; jamais d'erreur.
    async cancel() {
      if (!this._host) return;
      try {
        await this._send(this._host, { type: "cancel" }, this._timeoutMs);
      } catch (e) { /* PC déjà fermé ou injoignable : rien à faire */ }
    }
  }

  const api = { parseQr, SyncClient, syncMessage, MESSAGES };
  PPM.parseQr = parseQr;
  PPM.SyncClient = SyncClient;
  PPM.syncMessage = syncMessage;
  PPM.syncMessages = MESSAGES;
  if (typeof module === "object") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
