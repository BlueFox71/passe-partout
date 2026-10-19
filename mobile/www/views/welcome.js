/* Téléphone — accueil (pas encore de données) et écran « données illisibles » (coffre local corrompu). */
(function () {
  const V = (PP.views.welcome = {});

  // Synchronisation avec le PC : vue de la Tâche 12 si présente.
  V.goSync = () => {
    if (PP.views.sync && typeof PP.views.sync.show === "function") return PP.views.sync.show();
    PP.toast("Bientôt disponible");
  };

  // Aperçu dans le navigateur uniquement : bouton qui charge le coffre de démonstration.
  const demoButton = () =>
    PP.mobile && PP.mobile.preview
      ? `<button type="button" class="btn btn-ghost m-wide" id="demo">Charger les données de démonstration</button>
         <div class="hint m-center">Aperçu : le code de la démo est 1234</div>`
      : "";

  function bind(app) {
    app.querySelector("#sync").addEventListener("click", V.goSync);
    const demo = app.querySelector("#demo");
    if (demo) {
      demo.addEventListener("click", async () => {
        demo.disabled = true;
        demo.textContent = "Chargement…";
        try {
          await PP.mobile.loadDemo();
        } catch (e) {
          demo.disabled = false;
          demo.textContent = "Charger les données de démonstration";
        }
      });
    }
  }

  V.show = () => {
    const app = PP.render(`
      <div class="m-screen m-welcome">
        ${PP.brand("big-brand")}
        <div class="m-card glass">
          <h2>Bienvenue</h2>
          <p>Tes mots de passe et cartes cadeaux arrivent depuis Passe-Partout sur ton PC.
            Ouvre-le, choisis « Synchroniser le téléphone », puis scanne le QR code affiché.</p>
          <button type="button" class="btn btn-primary m-wide" id="sync">${PP.icon.sync}Synchroniser avec le PC</button>
          ${demoButton()}
        </div>
      </div>`);
    bind(app);
  };

  V.showCorrupt = () => {
    const app = PP.render(`
      <div class="m-screen m-welcome">
        ${PP.brand("big-brand")}
        <div class="m-card glass">
          <h2>Données illisibles</h2>
          <div class="warn-box">Les données de ce téléphone sont illisibles (sécurité Android réinitialisée ?).
            Resynchronise avec le PC : tes données seront récupérées depuis le PC ; les modifications faites sur
            ce téléphone depuis la dernière synchro seront perdues.</div>
          <button type="button" class="btn btn-primary m-wide" id="sync">${PP.icon.sync}Synchroniser avec le PC</button>
          ${demoButton()}
        </div>
      </div>`);
    bind(app);
  };
})();
