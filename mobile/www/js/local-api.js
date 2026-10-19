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
      this._keys = await this._readKeys();
      this._hasData = !!(this._keys && this._keys.code && (await n.readFile(VAULT_FILE)) !== null);
    }

    async _readKeys() {
      const raw = await this._native.readFile(KEYS_FILE);
      if (raw == null) return null;
      try {
        const k = JSON.parse(raw);
        return k && typeof k === "object" ? k : null;
      } catch (e) {
        return null;
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
      const raw = await this._native.readFile(VAULT_FILE);
      if (raw == null) return false;
      let v;
      try {
        v = await C.decryptVault(dataKey, JSON.parse(raw));
      } catch (e) {
        return false;
      }
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
          corrupt: false,
          profiles: this._vault ? clone(this._vault.profiles) : [],
          biometric: this._bioOn(),
        };
      });
    }

    unlock(code) {
      return this._run(async () => {
        const wait = this._lockout.waitSeconds();
        if (wait > 0) return { ok: false, wait_seconds: wait, error: "bad_code" };
        if (!this._hasData) return { ok: false, wait_seconds: 0, error: "corrupt" };
        code = String(code ?? "");
        let wrapped;
        try {
          wrapped = JSON.parse(dec.decode(await this._native.unwrap(ALIAS_CODE, this._keys.code)));
        } catch (e) {
          return { ok: false, wait_seconds: 0, error: "corrupt" }; // clé du Keystore perdue ou blob abîmé
        }
        let dataKey;
        try {
          dataKey = await C.unwrapWithCode(wrapped, code);
        } catch (e) {
          this._lockout.fail();
          await this._persistLockout();
          return { ok: false, wait_seconds: this._lockout.waitSeconds(), error: "bad_code" };
        }
        if (!(await this._open(dataKey))) return { ok: false, wait_seconds: 0, error: "corrupt" };
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
          await this._dropBio();
          return { ok: false, error: "bio_invalidated" };
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
        generation: strOrNull(this._meta.generation),
        last_sync: strOrNull(this._meta.last_sync),
        code_version: strOrNull(this._meta.code_version),
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
        const rv = resp && resp.vault;
        if (!rv || typeof rv !== "object"
          || !["profiles", "accounts", "giftcards", "deleted"].every((k) => Array.isArray(rv[k]))) {
          throw new Error("Réponse de synchronisation invalide");
        }
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
