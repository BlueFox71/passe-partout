/* Fenêtre d'export (texte / images) de la liste affichée. */
(function () {
  const V = (PP.views.export = {});

  V.open = (accounts, giftcards) => {
    let kind = "png";
    let withCards = false;
    const cats = new Set(accounts.map((a) => a.category || "Sans catégorie")).size;
    const m = PP.modal.open(`
      <h2>${PP.icon.export.replace("<svg", '<svg style="width:22px"')} Exporter</h2>
      <p style="color:var(--muted);margin:0 0 14px">Export de la liste affichée : <b style="color:var(--text)">${accounts.length} compte${accounts.length > 1 ? "s" : ""}</b>
        dans ${cats} catégorie${cats > 1 ? "s" : ""}.</p>
      <div class="choice-cards">
        <div class="choice-card on" data-k="png"><div class="ic">🖼️</div><b>Images</b><small>Une image néon par catégorie, à regarder dans la galerie du téléphone</small></div>
        <div class="choice-card" data-k="txt"><div class="ic">📄</div><b>Texte</b><small>Un fichier .txt où l'on peut faire une recherche</small></div>
      </div>
      <div style="margin:16px 0"><label class="toggle" id="x-gc"><i></i>Inclure les cartes cadeaux (${giftcards.length})</label></div>
      <div class="warn-box">⚠️ Les fichiers exportés <b>ne sont pas protégés</b> : n'importe qui ayant accès au téléphone pourra les lire.
        Range-les dans un dossier sûr et supprime-les quand tu n'en as plus besoin.</div>
      <div class="modal-foot"><button class="btn btn-ghost" id="x-no">Annuler</button>
        <button class="btn btn-primary" id="x-go" ${accounts.length || giftcards.length ? "" : "disabled"}>Choisir le dossier et exporter</button></div>`);
    m.querySelectorAll("[data-k]").forEach((c) => c.addEventListener("click", () => {
      kind = c.dataset.k;
      m.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === c));
    }));
    m.querySelector("#x-gc").addEventListener("click", (e) => {
      e.preventDefault();
      withCards = !withCards;
      m.querySelector("#x-gc").classList.toggle("on", withCards);
    });
    m.querySelector("#x-no").addEventListener("click", () => PP.modal.close());
    m.querySelector("#x-go").addEventListener("click", async () => {
      const r = await PP.call("export", kind, accounts.map((a) => a.id), withCards);
      if (!r) return; // dossier non choisi
      PP.modal.close();
      PP.toast(`${r.files.length} fichier${r.files.length > 1 ? "s" : ""} exporté${r.files.length > 1 ? "s" : ""}`, { seconds: 4 });
    });
  };
})();
