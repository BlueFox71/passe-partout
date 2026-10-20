/* Téléphone — démarrage : choix du natif (réel ou simulé), API locale, navigation, verrouillage en arrière-plan.
   ui/app.js (copié dans shared/) fournit PP ; PP.start n'est jamais appelé ici : boot.js le remplace. */
(function () {
  const PPM = window.PPM;
  const V = PPM.vault;
  const BACKGROUND_LOCK_MS = 30000; // verrouillage si l'appli est restée plus de 30 s en arrière-plan
  const DEFAULT_SETTINGS = { autolock_minutes: 5, biometric: false };
  const DEMO_CODE = "1234";
  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- natif
  let nativePlatform = false;
  try {
    nativePlatform = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === "function"
      && window.Capacitor.isNativePlatform());
  } catch (e) { /* Capacitor inutilisable : traité comme un navigateur */ }
  const isNative = nativePlatform;

  // Sur un vrai téléphone, jamais de repli sur le natif simulé (clés en clair dans localStorage) :
  // sans PPM.native, écran d'erreur et aucune donnée écrite.
  if (nativePlatform && !PPM.native) {
    PP.route = async () => {}; // ui/app.js (verrouillage, raccourcis) ne doit rien déclencher
    PP.render(`<div class="m-screen"><div class="m-card glass"><h2>Démarrage impossible</h2>
      <p>Le module de sécurité du téléphone est introuvable. Réinstalle Passe-Partout ;
        aucune donnée n'a été enregistrée.</p></div></div>`);
    return;
  }

  // localStorage peut être bloqué (navigation privée, aperçu) : repli en mémoire, sans erreur.
  function localStore() {
    let ls = null;
    try {
      ls = window.localStorage;
      ls.getItem("pp.probe");
    } catch (e) {
      ls = null;
    }
    const mem = PPM.nativeFake.memoryStore();
    return {
      getItem(k) {
        if (ls) {
          try {
            const v = ls.getItem(k);
            if (v !== null) return v;
          } catch (e) { /* lecture refusée : mémoire */ }
        }
        return mem.getItem(k);
      },
      setItem(k, v) {
        mem.setItem(k, v);
        if (ls) try { ls.setItem(k, v); } catch (e) { /* quota ou blocage : reste en mémoire */ }
      },
      removeItem(k) {
        mem.removeItem(k);
        if (ls) try { ls.removeItem(k); } catch (e) { /* ignoré */ }
      },
    };
  }

  // ?reset=1 (aperçu) : efface les données simulées pour repartir d'un téléphone neuf.
  function resetPreview() {
    try {
      const ls = window.localStorage;
      const keys = [];
      for (let i = 0; i < ls.length; i++) if (ls.key(i).startsWith("pp.fake.")) keys.push(ls.key(i));
      keys.forEach((k) => ls.removeItem(k));
    } catch (e) { /* stockage indisponible : rien à effacer */ }
  }

  // ?demo=sync (aperçu) : téléphone neuf face à un PC simulé, pour essayer la synchro sans PC ni téléphone.
  const demoSync = !isNative && params.get("demo") === "sync";
  if (!isNative && (params.get("reset") === "1" || demoSync)) resetPreview();
  const native = isNative ? PPM.native : PPM.nativeFake.create({ store: localStore() });
  PP.api = new PPM.LocalApi({ native });

  // ---------------------------------------------------------------- coffre de démonstration (aperçu)
  function demoResponse() {
    const now = new Date();
    const ts = V.nowIso(now);
    const day = (n) => V.todayIso(new Date(now.getTime() + n * 86400000));
    let seq = 0;
    const id = (p) => `demo-${p}-${++seq}`;
    const J = "demo-p-jules";
    const A = "demo-p-alexis";
    const acc = (name, category, login, password, extra = {}) => ({
      id: id("a"), name, category, login, password, login_mask: null, password_mask: null, image: null,
      favorite: false, profiles: [J], created: ts, updated: ts, ...extra,
    });
    const card = (name, code, pin, initial, remaining, end, extra = {}) => ({
      id: id("g"), name, code, pin, initial, remaining, end_date: end, image: null,
      profiles: [J], history: [], updated: ts, ...extra,
    });
    return {
      ok: true,
      vault: {
        version: 1,
        profiles: [
          { id: J, name: "Jules", avatar: null, color: "#ff3d9a", updated: ts },
          { id: A, name: "Alexis", avatar: null, color: "#00b8d9", updated: ts },
        ],
        accounts: [
          acc("BoursoBank", "Banque", "48213377", "Tr0mpette!Bleue", { favorite: true }),
          acc("PayPal", "Banque", "jules@exemple.fr", "Papillon#2024", { profiles: [J, A] }),
          acc("Impôts", "État", "1234567890123", "Fisc@lite2026", { login_mask: "## ## ### ### ###", favorite: true }),
          acc("Ameli", "Santé", "185067512345678", "Vitale!Carte77", { login_mask: "# ## ## ## ### ### ##" }),
          acc("Gmail", "Boîte mail", "jules@exemple.fr", "Nuage-Violet-88"),
          acc("Outlook", "Boîte mail", "alexis@exemple.fr", "Soleil-Levant-19", { profiles: [A] }),
          acc("Netflix", "Streaming", "famille@exemple.fr", "Chill&Popcorn9", { profiles: [J, A], favorite: true }),
          acc("Steam", "Plateforme de jeu", "julesgamer", "GabeN-3-confirmed"),
          acc("Discord", "Réseau social", "jules_rp", "D20-critique!"),
          acc("Instagram", "Réseau social", "alexis.photo", "Photo!Lumiere42", { profiles: [A] }),
          acc("Amazon", "Site Web", "jules@exemple.fr", "Colis!Rapide42", { profiles: [J, A] }),
        ],
        giftcards: [
          card("Fnac", "6301 2245 8890 1123", "4821", 50, 50, day(20)),
          card("Decathlon", "2090 5531 7742 0068", "", 40, 25.5, day(240), {
            profiles: [J, A],
            history: [{ id: id("h"), date: day(-12), amount: 14.5 }],
          }),
        ],
        bankcards: [
          { id: id("b"), name: "BoursoBank", holder: "JULES CANNET", number: "4970 1234 5678 1234", expiry: "12/28",
            cvv: "482", pin: "1234", image: null, profiles: [J], updated: ts },
          { id: id("b"), name: "Revolut", holder: "ALEXIS CANNET", number: "5355 2210 9876 5432", expiry: "03/27",
            cvv: "915", pin: "5678", image: null, profiles: [A], updated: ts },
        ],
        loyaltycards: [
          { id: id("l"), name: "Leclerc", number: "2912345678901", pin: "", image: null, profiles: [J, A], updated: ts },
          { id: id("l"), name: "Sephora", number: "", pin: "4821", image: null, profiles: [A], updated: ts },
        ],
        deleted: [],
      },
      summary: { to_pc: 0, to_phone: 19, deleted: 0, conflicts: 0 },
      code_version: "demo",
      generation: "demo",
      synced_at: ts,
      pc: "PC de démonstration",
      lock_mode: "pin",
      pin_length: DEMO_CODE.length,
    };
  }

  // Charge la démo (code 1234) puis affiche l'écran de verrouillage.
  async function loadDemo() {
    if (isNative) return;
    await PP.call("apply_sync", demoResponse(), DEMO_CODE);
    await PP.call("lock");
    PP.state.locked = true;
    PP.toast(`Démo chargée — code ${DEMO_CODE}`);
    await PP.route();
  }

  // Téléphone : le presse-papiers n'est pas effacé automatiquement (choix de Jules) ; ui/app.js (partagé avec
  // le PC, qui efface après 30 s) est donc remplacé ici par une version sans compte à rebours.
  PP.copySecret = async (text, what = "Mot de passe") => {
    await PP.call("copy_secret", text);
    PP.toast(`${what} copié`);
  };

  PP.mobile = { native, preview: !isNative, loadDemo };

  // ---------------------------------------------------------------- navigation
  PP.route = async () => {
    PP.modal.close();
    const s = await PP.refreshState();
    if (s.corrupt) return PP.views.welcome.showCorrupt();
    if (s.locked) return PP.views.lock.show();
    if (!s.has_data) return PP.views.welcome.show();
    // réglages lus après déverrouillage : le minuteur d'inactivité de ui/app.js s'en sert
    try {
      PP.state.settings = { ...DEFAULT_SETTINGS, ...(await PP.call("get_settings")) };
    } catch (e) {
      PP.state.settings = { ...DEFAULT_SETTINGS };
    }
    if (PP.state.profileId === undefined) PP.state.profileId = null; // « Tout le monde »
    return PP.views.shell.show();
  };

  // ---------------------------------------------------------------- arrière-plan
  // Ruling 23 : un écran natif lancé par l'appli (scanner, demande de permission, invite d'empreinte) met la
  // WebView en pause sans que l'utilisateur ait quitté l'appli : ce temps ne compte pas.
  let pausedAt = null;
  const inNativeScreen = () => typeof native.inNativeScreen === "function" && native.inNativeScreen();
  if (typeof native.onPause === "function") {
    native.onPause(() => { pausedAt = inNativeScreen() ? null : Date.now(); });
  }
  if (typeof native.onResume === "function") {
    native.onResume(() => {
      const away = pausedAt == null || inNativeScreen() ? 0 : Date.now() - pausedAt;
      pausedAt = null;
      const st = PP.state;
      if (away > BACKGROUND_LOCK_MS && st.has_data && !st.locked) PP.lockNow().catch(() => {});
    });
  }

  // ---------------------------------------------------------------- bouton retour (Android)
  // Synchro en cours d'envoi → ignoré (Ruling 22) ; synchro plein écran (accueil, données illisibles) →
  // retour à cet écran ; fenêtre, fiche ou formulaire ouvert → fermé ; autre onglet → Comptes ; sinon
  // (vrai renvoyé par personne) le natif met l'appli en arrière-plan.
  if (typeof native.onBack === "function") {
    native.onBack(() => {
      const sync = PP.views.sync;
      if (sync && sync.busy && sync.busy()) return true;
      if (sync && sync.fullscreen && sync.fullscreen()) {
        if (PP.modal.isOpen()) PP.modal.close();
        sync.clear(); // annule un hello ou une saisie de code en cours
        PP.route().catch(() => {});
        return true;
      }
      if (PP.mui && PP.mui.closeTop()) return true;
      const shell = PP.views.shell;
      if (shell && shell.active() && shell.tab() !== "accounts") {
        shell.show("accounts");
        return true;
      }
      return false;
    });
  }

  // ---------------------------------------------------------------- aperçu
  function previewBadge() {
    const b = document.createElement("div");
    b.className = "m-preview-badge";
    b.textContent = "APERÇU — données de démonstration";
    document.body.classList.add("m-preview");
    document.body.appendChild(b);
  }

  // Raccourcis d'URL pour les captures (natif simulé seulement) :
  // ?demo=1 charge la démo si le téléphone est vide ; &code=1234 déverrouille aussi.
  // ?demo=sync : accueil d'un téléphone neuf ; « Scanner » lit le QR d'un PC simulé (code 1234).
  async function urlHooks() {
    if (demoSync) {
      native.simulatePc({ code: DEMO_CODE, vault: demoResponse().vault, lockMode: "pin", pcName: "PC de démonstration" });
      PP.toast(`PC simulé prêt — code ${DEMO_CODE}`);
      return;
    }
    if (isNative || params.get("demo") !== "1") return;
    const s = await PP.refreshState();
    if (!s.has_data) {
      await PP.call("apply_sync", demoResponse(), DEMO_CODE);
      await PP.call("lock");
    }
    const code = params.get("code");
    if (code) {
      const st = await PP.refreshState();
      if (st.locked) await PP.call("unlock", code);
    }
  }

  async function start() {
    if (!isNative) previewBadge();
    PP.state.filter = "all";
    PP.state.query = "";
    try {
      await urlHooks();
    } catch (e) { /* erreur déjà signalée par PP.call */ }
    try {
      await PP.route();
    } catch (e) {
      PP.render(`<div class="m-screen"><div class="m-card glass"><h2>Démarrage impossible</h2>
        <p>${PP.esc((e && e.message) || "Erreur inconnue")}</p></div></div>`);
    }
  }

  start();
})();
