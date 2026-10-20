/* Téléphone — coquille de navigation : contenu de l'onglet + barre d'onglets du bas.
   Chaque onglet affiche PP.views.<accounts|bankcards|cards|sync|settings>.show(conteneur) s'il existe
   (Tâches 12 à 15), sinon « Bientôt disponible ».
   Contrat (décision 14) : PP.views.sync.show(container?) — sans conteneur, la vue de synchro s'affiche
   en plein écran (accueil, données illisibles : views/welcome.js) ; avec un conteneur, dans l'onglet Synchro. */
(function () {
  const V = (PP.views.shell = {});
  const KEY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2"/></svg>`;
  const TABS = [
    { id: "accounts", label: "Comptes", icon: KEY },
    { id: "bankcards", label: "Cartes", icon: PP.icon.card },
    { id: "cards", label: "Cadeaux", icon: PP.icon.gift },
    { id: "sync", label: "Synchro", icon: PP.icon.sync },
    { id: "settings", label: "Réglages", icon: PP.icon.gear },
  ];
  let mounted = false;

  V.body = () => document.getElementById("m-body");
  V.active = () => mounted && !!V.body();
  V.tab = () => PP.state.tab || "accounts";

  V.show = (tab) => {
    if (tab) PP.state.tab = tab;
    const current = V.tab();
    const app = PP.render(`
      <div class="m-shell">
        <main class="m-body" id="m-body"></main>
        <nav class="m-tabs">
          ${TABS.map((t) => `<button type="button" class="m-tab${t.id === current ? " on" : ""}" data-tab="${t.id}"
              aria-label="${t.label}"${t.id === current ? ' aria-current="page"' : ""}>${t.icon}<span>${t.label}</span></button>`).join("")}
        </nav>
      </div>`);
    mounted = true;
    app.querySelectorAll("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        if (syncBusy()) return; // Ruling 22 : pas de changement d'onglet pendant l'envoi de la synchro
        if (b.dataset.tab !== V.tab()) V.show(b.dataset.tab);
      })
    );
    renderTab(current);
  };

  const syncBusy = () => !!(PP.views.sync && PP.views.sync.busy && PP.views.sync.busy());

  // Barre d'onglets grisée pendant l'envoi de la synchro (appelé par views/sync.js).
  V.setLocked = (on) => {
    document.querySelectorAll(".m-tabs .m-tab").forEach((b) => { b.disabled = !!on; });
  };

  function renderTab(id) {
    // quitter l'onglet Synchro : hello ou saisie du code en cours annulés (cancel envoyé au PC)
    if (id !== "sync" && PP.views.sync && typeof PP.views.sync.clear === "function") PP.views.sync.clear();
    const body = V.body();
    const view = PP.views[id];
    if (view && typeof view.show === "function") {
      body.innerHTML = "";
      return view.show(body);
    }
    const t = TABS.find((x) => x.id === id) || TABS[0];
    body.innerHTML = `
      <div class="m-head"><h1>${t.label}</h1></div>
      <div class="empty m-soon"><div class="m-soon-ic">${t.icon}</div><div>Bientôt disponible</div></div>`;
  }

  // Au verrouillage : plus aucune donnée du coffre dans la page.
  V.clear = () => {
    for (const t of TABS) {
      const view = PP.views[t.id];
      if (view && typeof view.clear === "function") {
        try { view.clear(); } catch (e) { /* vue partielle : on vide quand même */ }
      }
    }
    const body = V.body();
    if (body) body.innerHTML = "";
    mounted = false;
  };

  // ui/app.js appelle PP.views.main (verrouillage, raccourcis clavier, choix du profil) : délégation sûre.
  const accounts = () => PP.views.accounts || {};
  PP.views.main = {
    show: () => V.show(),
    clear: () => V.clear(),
    active: () => V.active() && V.tab() === "accounts",
    focusSearch: () => { if (typeof accounts().focusSearch === "function") accounts().focusSearch(); },
    newItem: () => { if (typeof accounts().newItem === "function") accounts().newItem(); },
  };
})();
