// Natif réel (téléphone Android, Capacitor) : même interface que PPM.nativeFake (js/native-fake.js).
// boot.js ne l'utilise que si Capacitor.isNativePlatform() ; dans le navigateur, PPM.native reste absent.
//
// Keystore, empreinte, presse-papiers et QR code : plugin PassePartout (android/…/PassePartoutPlugin.java).
// Fichiers : @capacitor/filesystem (Directory.Data, privé à l'appli) ; préférences : @capacitor/preferences
// (valeurs JSON) ; nom de l'appareil : @capacitor/device ; cycle de vie et bouton retour : @capacitor/app ;
// requêtes vers le PC : CapacitorHttp (natif, donc sans blocage du contenu mixte http:// par la WebView).
// Codes d'erreur de unwrap : KEY_MISSING | KEY_INVALIDATED | BAD_BLOB | CANCELED | LOCKOUT | FAILED.
// inNativeScreen() : vrai pendant un écran natif lancé par l'appli (scanner et sa demande de permission,
// invite d'empreinte, installateur de la mise à jour et son écran d'autorisation) ; boot.js ne compte pas ce temps comme « arrière-plan » (Ruling 23).
// Aucun secret n'est journalisé.
(function (root) {
  const Cap = root.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return;

  const DATA = "DATA"; // Directory.Data
  const UTF8 = "utf8"; // Encoding.UTF8
  const TMP = ".tmp";

  function plugin(name) {
    const p = (Cap.Plugins && Cap.Plugins[name]) || (typeof Cap.registerPlugin === "function" ? Cap.registerPlugin(name) : null);
    if (!p) throw new Error(`Module natif ${name} introuvable`);
    return p;
  }
  const PassePartout = plugin("PassePartout");
  const Filesystem = plugin("Filesystem");
  const Preferences = plugin("Preferences");
  const Device = plugin("Device");
  const App = plugin("App");
  const Http = plugin("CapacitorHttp");

  function b64(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  // Base64 standard par blocs (multiples de 3 octets) : un APK de ~15 Mo sans concaténer octet par octet.
  function b64Large(bytes) {
    const CHUNK = 0x6000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))));
    }
    return parts.join("");
  }

  function unb64(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function nativeError(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
  }

  // Erreur du pont Capacitor → Error avec un code connu (FAILED par défaut).
  function coded(e, known) {
    const code = e && known.includes(e.code) ? e.code : "FAILED";
    return nativeError(code, (e && e.message) || code);
  }

  const UNWRAP_CODES = ["KEY_MISSING", "KEY_INVALIDATED", "BAD_BLOB", "CANCELED", "LOCKOUT", "FAILED"];

  // ---------------------------------------------------------------- écrans natifs (Ruling 23)
  let screens = 0;
  async function onScreen(fn) {
    screens++;
    try {
      return await fn();
    } finally {
      screens--;
    }
  }


  // ---------------------------------------------------------------- fichiers
  function isMissing(e) {
    return !!e && (e.code === "OS-PLUG-FILE-0008" || /does not exist|n'existe pas/i.test(String(e.message || "")));
  }

  async function readRaw(path) {
    try {
      const r = await Filesystem.readFile({ path, directory: DATA, encoding: UTF8 });
      return typeof r.data === "string" ? r.data : String(r.data ?? "");
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async function removeRaw(path) {
    try {
      await Filesystem.deleteFile({ path, directory: DATA });
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  // ---------------------------------------------------------------- bouton retour
  const backCbs = [];
  let backListening = false;

  const native = {
    // ------------------------------------------------------------ Keystore
    async wrap(alias, bytes, { biometric = false, title } = {}) {
      const opts = { alias: String(alias), data: b64(bytes), biometric: !!biometric };
      if (title) opts.title = String(title);
      try {
        const call = () => PassePartout.wrap(opts);
        const r = await (biometric ? onScreen(call) : call()); // invite d'empreinte
        return r.blob;
      } catch (e) {
        throw coded(e, UNWRAP_CODES);
      }
    },

    // `title` n'est donné que pour la clé à empreinte : l'invite s'affiche alors.
    async unwrap(alias, blob, { title } = {}) {
      const opts = { alias: String(alias), blob: String(blob) };
      if (title) opts.title = String(title);
      let r;
      try {
        const call = () => PassePartout.unwrap(opts);
        r = await (title ? onScreen(call) : call());
      } catch (e) {
        throw coded(e, UNWRAP_CODES);
      }
      try {
        return unb64(r.data);
      } catch (e) {
        throw nativeError("FAILED");
      }
    },

    async deleteKey(alias) {
      await PassePartout.deleteKey({ alias: String(alias) });
    },

    async biometricAvailable() {
      try {
        return !!(await PassePartout.biometricAvailable()).available;
      } catch (e) {
        return false;
      }
    },

    // ------------------------------------------------------------ presse-papiers
    async copySensitive(text) {
      await PassePartout.copySensitive({ text: String(text) });
    },

    async copyPlain(text) {
      await PassePartout.copyPlain({ text: String(text) });
    },

    // ------------------------------------------------------------ fichiers (Directory.Data)
    // Écriture atomique : name.tmp complet, puis renommé en name. Filesystem.rename efface la cible avant
    // de renommer : si l'appli meurt entre les deux, seul name.tmp (complet) reste et readFile le reprend.
    async readFile(name) {
      const data = await readRaw(name);
      if (data !== null) return data;
      const tmp = await readRaw(name + TMP);
      if (tmp === null) return null;
      try {
        await Filesystem.rename({ from: name + TMP, to: name, directory: DATA, toDirectory: DATA });
      } catch (e) { /* relu tel quel ; le prochain enregistrement réécrira le fichier */ }
      return tmp;
    },

    async writeFileAtomic(name, text) {
      await Filesystem.writeFile({ path: name + TMP, data: String(text), directory: DATA, encoding: UTF8 });
      await Filesystem.rename({ from: name + TMP, to: name, directory: DATA, toDirectory: DATA });
    },

    async removeFile(name) {
      // .tmp d'abord : sinon readFile pourrait le reprendre une fois la cible effacée
      await removeRaw(name + TMP);
      await removeRaw(name);
    },

    // ------------------------------------------------------------ préférences (JSON)
    async getPref(key) {
      const { value } = await Preferences.get({ key: String(key) });
      if (value == null) return null;
      try {
        return JSON.parse(value);
      } catch (e) {
        return null;
      }
    },

    async setPref(key, value) {
      await Preferences.set({ key: String(key), value: JSON.stringify(value) });
    },

    // ------------------------------------------------------------ appareil, cycle de vie
    async deviceName() {
      try {
        const info = await Device.getInfo();
        const n = info && typeof info.name === "string" ? info.name.trim() : "";
        return n || "Téléphone";
      } catch (e) {
        return "Téléphone";
      }
    },

    inNativeScreen() { return screens > 0; },

    onPause(cb) { App.addListener("pause", () => cb()); },
    onResume(cb) { App.addListener("resume", () => cb()); },

    // Bouton retour d'Android : les rappels sont essayés du dernier au premier ; le premier qui renvoie
    // vrai a traité l'appui. Sinon l'appli passe en arrière-plan (jamais fermée).
    onBack(cb) {
      backCbs.push(cb);
      if (backListening) return;
      backListening = true;
      App.addListener("backButton", async () => {
        for (let i = backCbs.length - 1; i >= 0; i--) {
          try {
            if (await backCbs[i]()) return;
          } catch (e) { /* rappel en erreur : essai suivant */ }
        }
        try {
          await App.minimizeApp();
        } catch (e) { /* rien à faire */ }
      });
    },

    // ------------------------------------------------------------ QR code (ZXing, local)
    // Texte du QR, ou null si le scan est annulé ; Error.code « CAMERA_DENIED » si l'appareil photo est refusé.
    async scanQr() {
      try {
        const r = await onScreen(() => PassePartout.scanQr()); // scanner et demande de permission
        return r && typeof r.text === "string" ? r.text : null;
      } catch (e) {
        throw coded(e, ["CAMERA_DENIED", "FAILED"]);
      }
    },

    // ------------------------------------------------------------ mise à jour de l'appli
    // APK vérifié (octets) → cache de l'appli → installateur d'Android. Se termine au retour dans l'appli.
    // Error.code « INSTALL_PERMISSION » : l'écran d'autorisation d'Android a été montré, réessayer ensuite.
    // Error.code « INVALID_APK » : APK refusé (autre paquet, autre signature, version pas plus récente) ; rien d'installé.
    async installApk(bytes) {
      const data = b64Large(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      try {
        await onScreen(() => PassePartout.installApk({ data }));
      } catch (e) {
        throw coded(e, ["INSTALL_PERMISSION", "INVALID_APK", "FAILED"]);
      }
    },

    // ------------------------------------------------------------ réseau
    // POST JSON vers le PC ; {status, text}. Réseau injoignable ou délai dépassé : Error.code « NETWORK ».
    async post(url, body, timeoutMs) {
      let r;
      try {
        r = await Http.request({
          url: String(url),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          data: String(body),
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
          responseType: "text",
        });
      } catch (e) {
        throw nativeError("NETWORK", "PC injoignable");
      }
      // une réponse application/json est déjà décodée par CapacitorHttp : on la réécrit en texte
      const d = r.data;
      const text = d == null ? "" : typeof d === "string" ? d : JSON.stringify(d);
      return { status: r.status, text };
    },
  };

  root.PPM = root.PPM || {};
  root.PPM.native = native;
})(typeof window !== "undefined" ? window : globalThis);
