// Coffre local du téléphone : mêmes noms et formes que l'Api Python (app/api.py), pour que l'interface
// partagée (PP.call) fonctionne telle quelle. Toutes les méthodes sont asynchrones et exécutées une à une.
//
// Stockage (via le natif) :
//   vault.enc  = encryptVault(clé de données, coffre)
//   keys.json  = {"code": wrap("pp-device", JSON(wrapWithCode(clé, code))), "bio"?: wrap("pp-bio", clé, biométrique)}
//   préférences pp.meta = {device_id, last_sync, generation, code_version, pc_name, lock_mode, pin_length},
//   pp.settings = {autolock_minutes, biometric}, pp.lockout = état du délai anti-essais.
// Aucun secret (code, clé, mot de passe) n'est journalisé ni écrit en clair.
(function (root) {
  const PPM = (root.PPM = root.PPM || {});
  if (typeof module === "object" && typeof require === "function") {
    if (!PPM.crypto) require("./crypto.js");
    if (!PPM.Lockout) require("./lockout.js");
    if (!PPM.vault) require("./vaultlogic.js");
  }
  const C = PPM.crypto;
  const V = PPM.vault;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const VAULT_FILE = "vault.enc";
  const KEYS_FILE = "keys.json";
  const ALIAS_CODE = "pp-device";
  const ALIAS_BIO = "pp-bio";
  const CLIPBOARD_SECONDS = 30;
  const IMAGE_MAX = 256;
  const LOCKED = "Coffre verrouillé";
  const DEFAULT_SETTINGS = { autolock_minutes: 5, biometric: false };
  const META_KEYS = ["device_id", "last_sync", "generation", "code_version", "pc_name", "lock_mode", "pin_length"];

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const strOrNull = (x) => (typeof x === "string" && x ? x : null);
  const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

  function parseJson(raw) {
    if (typeof raw !== "string") return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- validation du coffre reçu du PC
  // Mêmes règles minimales que validate_phone_vault (app/syncflow.py) : ce coffre sera renvoyé au PC.
  const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const KINDS = ["account", "giftcard", "profile"];

  function invalid() {
    throw new Error("Réponse de synchronisation invalide");
  }

  function realDate(m, withTime) {
    const t = withTime ? [+m[4], +m[5], +m[6]] : [0, 0, 0];
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], ...t));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
      && d.getUTCHours() === t[0] && d.getUTCMinutes() === t[1] && d.getUTCSeconds() === t[2];
  }

  function checkTs(v) {
    const m = typeof v === "string" ? TS_RE.exec(v) : null;
    if (!m || !realDate(m, true)) invalid();
  }

  function checkDay(v) {
    const m = typeof v === "string" ? DAY_RE.exec(v) : null;
    if (!m || !realDate(m, false)) invalid();
  }

  function checkStr(d, key, { required = false, nullable = false } = {}) {
    if (!(key in d)) {
      if (required) invalid();
      return;
    }
    const v = d[key];
    if (v === null && nullable) return;
    if (typeof v !== "string" || (required && !v)) invalid();
  }

  function checkAmount(v, positive = false) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (positive && v === 0)) invalid();
  }

  function checkImage(d, key) {
    const v = d[key];
    if (v != null && !(typeof v === "string" && v.startsWith("data:image/"))) invalid();
  }

  function checkItem(d, strs, optStrs) {
    if (!isObj(d)) invalid();
    checkStr(d, "id", { required: true });
    checkStr(d, "name", { required: true });
    checkTs(d.updated);
    for (const k of strs) checkStr(d, k);
    for (const k of optStrs) checkStr(d, k, { nullable: true });
  }

  // Listes d'ids de profils exigées (le PC les envoie toujours) : le téléphone les lit pour filtrer.
  function checkProfileIds(d) {
    if (!Array.isArray(d.profiles) || !d.profiles.every((x) => typeof x === "string")) invalid();
  }

  function onlyKeys(d, keys) {
    if (!Object.keys(d).every((k) => keys.includes(k))) invalid();
  }

  function validateVault(rv) {
    if (!isObj(rv)) invalid();
    for (const k of ["profiles", "accounts", "giftcards", "deleted"]) if (!Array.isArray(rv[k])) invalid();
    for (const p of rv.profiles) {
      checkItem(p, [], ["avatar", "color"]);
      checkImage(p, "avatar");
    }
    for (const a of rv.accounts) {
      checkItem(a, ["category", "login", "password"], ["login_mask", "password_mask"]);
      checkImage(a, "image");
      checkProfileIds(a);
      if ("favorite" in a && typeof a.favorite !== "boolean") invalid();
      if ("created" in a) checkTs(a.created);
    }
    for (const g of rv.giftcards) {
      checkItem(g, ["code", "pin"], ["end_date"]);
      if (g.end_date != null) checkDay(g.end_date);
      checkImage(g, "image");
      checkProfileIds(g);
      if (g.initial != null) checkAmount(g.initial);
      checkAmount(g.remaining);
      if (!Array.isArray(g.history)) invalid();
      for (const h of g.history) {
        if (!isObj(h)) invalid();
        onlyKeys(h, ["id", "date", "amount"]);
        checkStr(h, "id", { required: true });
        checkDay(h.date);
        checkAmount(h.amount, true);
      }
    }
    for (const t of rv.deleted) {
      if (!isObj(t) || !KINDS.includes(t.kind)) invalid();
      onlyKeys(t, ["kind", "id", "at"]);
      checkStr(t, "id", { required: true });
      checkTs(t.at);
    }
    for (const k of ["profiles", "accounts", "giftcards"]) {
      const ids = rv[k].map((x) => x.id);
      if (new Set(ids).size !== ids.length) invalid();
    }
  }

  // Formes de vault.enc et de l'enveloppe du code : illisibles = coffre corrompu (jamais « mauvais code »).
  const isBlob = (b) => isObj(b) && typeof b.iv === "string" && typeof b.ct === "string";
  const isWrapped = (w) => isObj(w) && typeof w.salt === "string" && typeof w.iv === "string"
    && typeof w.ct === "string" && Number.isInteger(w.iter) && w.iter > 0;

  class LocalApi {
    // `iterations` : réservé aux tests (PBKDF2 réduit) ; en production, la valeur du module crypto.
    constructor({ native, clock = Date.now, iterations = C.PBKDF2_ITERATIONS } = {}) {
      this._native = native;
      this._clock = clock;
      this._iterations = iterations;
      this._queue = Promise.resolve();
      this._loaded = null;
      this._dataKey = null; // présente seulement déverrouillé
      this._vault = null;
      this._corrupt = false; // coffre local illisible : le téléphone se présente comme neuf au PC
    }

    // ------------------------------------------------------------ interne
    // Exécute les appels l'un après l'autre (pas d'écritures entrelacées).
    _run(fn) {
      const p = this._queue.then(() => this._load()).then(fn);
      this._queue = p.catch(() => {});
      return p;
    }

    _load() {
      if (!this._loaded) {
        this._loaded = this._init().catch((e) => {
          this._loaded = null;
          throw e;
        });
      }
      return this._loaded;
    }

    async _init() {
      const n = this._native;
      const meta = (await n.getPref("pp.meta")) || {};
      this._meta = {};
      for (const k of META_KEYS) this._meta[k] = meta[k] ?? null;
      if (!this._meta.device_id) {
        this._meta.device_id = V.newId(); // identifiant aléatoire créé au premier lancement
        await n.setPref("pp.meta", this._meta);
      }
      const settings = (await n.getPref("pp.settings")) || {};
      this._settings = { ...DEFAULT_SETTINGS };
      if (Number.isFinite(settings.autolock_minutes)) this._settings.autolock_minutes = settings.autolock_minutes;
      this._settings.biometric = settings.biometric === true;
      this._lockout = new PPM.Lockout(this._clock, (await n.getPref("pp.lockout")) || {});
      // aucun des deux fichiers : téléphone neuf ; un seul, ou illisible (synchro interrompue, fichier
      // abîmé) : coffre corrompu, réparé par la prochaine synchro
      const keysRaw = await n.readFile(KEYS_FILE);
      const vaultRaw = await n.readFile(VAULT_FILE);
      this._keys = parseJson(keysRaw);
      this._hasData = false;
      if (keysRaw == null && vaultRaw == null) return;
      if (isObj(this._keys) && typeof this._keys.code === "string" && isBlob(parseJson(vaultRaw))) {
        this._hasData = true;
      } else {
        this._keys = null;
        this._corrupt = true;
      }
    }

    // Coffre local inutilisable (clé du Keystore perdue, fichier abîmé) : rien n'est effacé ; la prochaine
    // synchro (code du PC exigé) repart d'une nouvelle clé de données, comme un premier lancement.
    async _markCorrupt() {
      this._corrupt = true;
      this._hasData = false;
      this._dataKey = null;
      this._vault = null;
      if (this._settings.biometric) {
        this._settings.biometric = false; // l'ancien blob d'empreinte enveloppait l'ancienne clé de données
        await this._saveSettings();
      }
    }

    _date() {
      return new Date(this._clock());
    }

    _v() {
      if (!this._vault) throw new Error(LOCKED);
      return this._vault;
    }

    _lockMode() {
      if (!this._hasData) return "none";
      const m = this._meta.lock_mode;
      return m === "pin" || m === "password" ? m : "unknown";
    }

    _bioOn() {
      return this._settings.biometric && !!(this._keys && this._keys.bio);
    }

    async _saveVault() {
      const blob = await C.encryptVault(this._dataKey, this._v());
      await this._native.writeFileAtomic(VAULT_FILE, JSON.stringify(blob));
    }

    async _saveKeys() {
      await this._native.writeFileAtomic(KEYS_FILE, JSON.stringify(this._keys));
    }

    async _saveMeta() {
      await this._native.setPref("pp.meta", this._meta);
    }

    async _saveSettings() {
      await this._native.setPref("pp.settings", this._settings);
    }

    async _persistLockout() {
      try {
        await this._native.setPref("pp.lockout", this._lockout.toJSON());
      } catch (e) { /* préférence non écrite : le délai reste appliqué en mémoire */ }
    }

    async _wrapCode(dataKey, code) {
      const wrapped = await C.wrapWithCode(dataKey, String(code), this._iterations);
      return this._native.wrap(ALIAS_CODE, enc.encode(JSON.stringify(wrapped)));
    }

    // Déchiffre le coffre avec la clé ; vrai si tout va bien.
    async _open(dataKey) {
      const blob = parseJson(await this._native.readFile(VAULT_FILE));
      if (!isBlob(blob)) return false;
      let v;
      try {
        v = await C.decryptVault(dataKey, blob);
      } catch (e) {
        return false;
      }
      if (!isObj(v)) return false;
      this._dataKey = dataKey;
      this._vault = { ...V.empty(), ...v };
      return true;
    }

    async _dropBio() {
      if (this._keys && this._keys.bio) {
        delete this._keys.bio;
        await this._saveKeys();
      }
      try {
        await this._native.deleteKey(ALIAS_BIO);
      } catch (e) { /* clé déjà absente */ }
      this._settings.biometric = false;
      await this._saveSettings();
    }

    // Modification du coffre : fn(coffre, maintenant, last_sync) puis réécriture de vault.enc.
    _modify(fn) {
      return this._run(async () => {
        const v = this._v();
        const d = this._date();
        const out = fn(v, d, this._meta.last_sync);
        await this._saveVault();
        return out === undefined ? {} : clone(out);
      });
    }

    // ------------------------------------------------------------ état, verrou
    get_state() {
      return this._run(async () => {
        const mode = this._lockMode();
        return {
          locked: this._hasData && !this._vault,
          lock_mode: mode,
          pin_length: mode === "pin" ? this._meta.pin_length ?? null : null,
          has_data: this._hasData,
          corrupt: this._corrupt,
          profiles: this._vault ? clone(this._vault.profiles) : [],
          biometric: this._bioOn(),
        };
      });
    }

    unlock(code) {
      return this._run(async () => {
        const wait = this._lockout.waitSeconds();
        if (wait > 0) return { ok: false, wait_seconds: wait, error: "bad_code" };
        const corrupt = { ok: false, wait_seconds: 0, error: "corrupt" };
        if (!this._hasData) return corrupt;
        code = String(code ?? "");
        // couche Keystore et format des fichiers : indépendants du code saisi → « corrupt »
        let wrapped = null;
        try {
          wrapped = parseJson(dec.decode(await this._native.unwrap(ALIAS_CODE, this._keys.code)));
        } catch (e) { /* clé du Keystore perdue ou blob abîmé */ }
        if (!isWrapped(wrapped)) {
          await this._markCorrupt();
          return corrupt;
        }
        // seule l'épreuve du code peut donner « bad_code » : un mauvais PIN n'efface jamais rien
        let dataKey;
        try {
          dataKey = await C.unwrapWithCode(wrapped, code);
        } catch (e) {
          this._lockout.fail();
          await this._persistLockout();
          return { ok: false, wait_seconds: this._lockout.waitSeconds(), error: "bad_code" };
        }
        if (!(await this._open(dataKey))) {
          await this._markCorrupt(); // bon code mais vault.enc illisible
          return corrupt;
        }
        this._lockout.success();
        await this._persistLockout();
        if (this._lockMode() === "pin" && /^\d+$/.test(code) && this._meta.pin_length !== code.length) {
          // longueur du PIN, pour valider automatiquement la saisie au prochain déverrouillage
          this._meta.pin_length = code.length;
          await this._saveMeta();
        }
        return { ok: true, wait_seconds: 0 };
      });
    }

    unlock_biometric() {
      return this._run(async () => {
        if (!this._hasData || !this._bioOn()) return { ok: false, error: "bio_invalidated" };
        let dataKey;
        try {
          dataKey = await this._native.unwrap(ALIAS_BIO, this._keys.bio, { title: "Déverrouiller Passe-Partout" });
        } catch (e) {
          if (e && e.code === "CANCELED") return { ok: false, error: "canceled" };
          // empreinte ajoutée ou retirée dans Android (KEY_INVALIDATED) ou clé inutilisable : on désactive
          await this._dropBio();
          return { ok: false, error: "bio_invalidated" };
        }
        if (!(await this._open(new Uint8Array(dataKey)))) {
          await this._markCorrupt(); // clé obtenue mais vault.enc illisible
          return { ok: false, error: "corrupt" };
        }
        this._lockout.success();
        await this._persistLockout();
        return { ok: true };
      });
    }

    lock() {
      return this._run(async () => {
        this._dataKey = null;
        this._vault = null;
        return {};
      });
    }

    // ------------------------------------------------------------ réglages
    get_settings() {
      return this._run(async () => {
        this._v();
        return { autolock_minutes: this._settings.autolock_minutes, biometric: this._bioOn() };
      });
    }

    save_settings(changes = {}) {
      return this._run(async () => {
        this._v();
        if ("autolock_minutes" in changes) {
          const m = Math.trunc(Number(changes.autolock_minutes));
          if (!Number.isFinite(m)) throw new Error("Délai de verrouillage invalide");
          this._settings.autolock_minutes = Math.max(0, m);
        }
        if (changes.biometric === true && !this._bioOn()) {
          if (!(await this._native.biometricAvailable())) {
            throw new Error("L'empreinte digitale n'est pas disponible sur ce téléphone");
          }
          let blob;
          try {
            blob = await this._native.wrap(ALIAS_BIO, this._dataKey, { biometric: true });
          } catch (e) {
            if (e && e.code === "CANCELED") throw new Error("Activation de l'empreinte annulée");
            throw new Error("Impossible d'activer l'empreinte digitale");
          }
          this._keys = { ...this._keys, bio: blob };
          await this._saveKeys();
          this._settings.biometric = true;
        } else if (changes.biometric === false) {
          await this._dropBio();
        }
        await this._saveSettings();
        return { autolock_minutes: this._settings.autolock_minutes, biometric: this._bioOn() };
      });
    }

    // ------------------------------------------------------------ comptes et cartes
    list_accounts(profileId) {
      return this._run(async () => clone(V.listAccounts(this._v(), profileId ?? null)));
    }

    save_account(data) {
      return this._modify((v, d, last) => V.saveAccount(v, data || {}, V.nowIso(d), last));
    }

    delete_account(id) {
      return this._modify((v, d, last) => { V.deleteItem(v, "account", id, V.nowIso(d), last); });
    }

    list_giftcards(profileId) {
      return this._run(async () => clone(V.listGiftcards(this._v(), profileId ?? null)));
    }

    save_giftcard(data) {
      return this._modify((v, d, last) => V.saveGiftcard(v, data || {}, V.nowIso(d), last));
    }

    delete_giftcard(id) {
      return this._modify((v, d, last) => { V.deleteItem(v, "giftcard", id, V.nowIso(d), last); });
    }

    spend(id, amount) {
      return this._modify((v, d, last) => V.spend(v, id, amount, V.todayIso(d), V.nowIso(d), last));
    }

    // ------------------------------------------------------------ presse-papiers, images
    copy_secret(text) {
      return this._run(async () => {
        await this._native.copySensitive(String(text), CLIPBOARD_SECONDS);
        return {};
      });
    }

    copy_plain(text) {
      return this._run(async () => {
        await this._native.copyPlain(String(text));
        return {};
      });
    }

    // Image réduite à 256 px au plus, en PNG (navigateur uniquement : canvas).
    normalize_image(dataUrl) {
      if (typeof document === "undefined" || typeof Image === "undefined") {
        return Promise.reject(new Error("Image non prise en charge ici"));
      }
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const scale = Math.min(1, IMAGE_MAX / Math.max(img.naturalWidth, img.naturalHeight));
          const w = Math.max(1, Math.round(img.naturalWidth * scale));
          const h = Math.max(1, Math.round(img.naturalHeight * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("Image illisible"));
        img.src = String(dataUrl);
      });
    }

    // ------------------------------------------------------------ synchro
    sync_info() {
      return this._run(async () => ({
        device_id: this._meta.device_id,
        device_name: String(await this._native.deviceName()),
        // sans données utilisables (neuf ou corrompu) : présenté comme neuf, le PC exige le code et remplace
        generation: this._hasData ? strOrNull(this._meta.generation) : null,
        last_sync: this._hasData ? strOrNull(this._meta.last_sync) : null,
        code_version: this._hasData ? strOrNull(this._meta.code_version) : null,
        has_data: this._hasData,
        now: V.nowIso(this._date()),
      }));
    }

    // Coffre envoyé au PC (validé par validate_phone_vault) ; vide avant la première synchro.
    sync_payload() {
      return this._run(async () => {
        if (!this._hasData) return { profiles: [], accounts: [], giftcards: [], deleted: [] };
        const v = this._v();
        return clone({ profiles: v.profiles, accounts: v.accounts, giftcards: v.giftcards, deleted: v.deleted });
      });
    }

    // Réponse de synchro réussie du PC ; `code` = code du PC saisi (obligatoire au premier lancement).
    // Ordre d'écriture : vault.enc → keys.json → pp.meta.
    apply_sync(resp, code = null) {
      return this._run(async () => {
        // tout est vérifié avant la moindre écriture
        if (!isObj(resp) || resp.ok !== true) invalid();
        const rv = resp.vault;
        validateVault(rv);
        const hasCode = typeof code === "string" && code !== "";
        let dataKey = this._dataKey;
        let newKey = false;
        if (!dataKey) {
          if (this._hasData) throw new Error(LOCKED);
          if (!hasCode) throw new Error("Le code du PC est nécessaire pour la première synchronisation");
          dataKey = C.randomBytes(32);
          newKey = true;
        }
        const vault = {
          version: 1, profiles: rv.profiles, accounts: rv.accounts, giftcards: rv.giftcards, deleted: rv.deleted,
        };

        // 1. coffre
        const blob = await C.encryptVault(dataKey, vault);
        await this._native.writeFileAtomic(VAULT_FILE, JSON.stringify(blob));
        this._dataKey = dataKey;
        this._vault = clone(vault);
        this._hasData = true;
        this._corrupt = false;

        // 2. clés : nouveau code (ou nouvelle clé) ; l'empreinte n'est refaite que si la clé change
        if (hasCode) {
          const keys = { code: await this._wrapCode(dataKey, code) };
          if (!newKey && this._keys && this._keys.bio) keys.bio = this._keys.bio;
          if (newKey && this._settings.biometric) {
            try {
              keys.bio = await this._native.wrap(ALIAS_BIO, dataKey, { biometric: true });
            } catch (e) {
              this._settings.biometric = false;
              await this._saveSettings();
            }
          }
          this._keys = keys;
          await this._saveKeys();
        }

        // 3. métadonnées
        const m = this._meta;
        m.last_sync = strOrNull(resp.synced_at);
        m.generation = strOrNull(resp.generation);
        m.code_version = strOrNull(resp.code_version);
        if (typeof resp.pc === "string" && resp.pc) m.pc_name = resp.pc;
        m.lock_mode = ["pin", "password"].includes(resp.lock_mode) ? resp.lock_mode : "unknown";
        m.pin_length = m.lock_mode === "pin" && Number.isInteger(resp.pin_length) ? resp.pin_length : null;
        await this._saveMeta();
        return {};
      });
    }
  }

  PPM.LocalApi = LocalApi;
  if (typeof module === "object") module.exports = LocalApi;
})(typeof window !== "undefined" ? window : globalThis);
