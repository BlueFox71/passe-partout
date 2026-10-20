/* Cartes fidélité : tuiles (enseigne, identifiant), fiche avec copie par champ (PIN masqué), formulaire.
   Identifiant et PIN sont facultatifs ; sur le téléphone, l'identifiant peut être scanné. */
(function () {
  const V = (PP.views.loyalty = {});

  V.render = (container, cards) => {
    container.innerHTML = `
      <div class="gc-wrap">
        <div class="list-head" style="padding:0 0 16px"><div><h2>Cartes fidélité</h2>
          <small>${cards.length} carte${cards.length > 1 ? "s" : ""}</small></div>
          <button class="btn btn-primary" id="lc-new">${PP.icon.plus} Nouvelle carte</button></div>
        ${cards.length ? `<div class="gc-grid">${cards.map((c) => `
            <div class="gc lc" data-l="${PP.esc(c.id)}">
              <div class="top">${PP.bankcard.logo(c)}<b style="font-size:16px">${PP.esc(c.name)}</b></div>
              <div class="lc-num">${c.number ? PP.esc(c.number) : '<span style="color:var(--faint);font-family:inherit;letter-spacing:0">Sans identifiant</span>'}</div>
            </div>`).join("")}</div>`
          : `<div class="empty"><div class="big">🏷️</div>Aucune carte fidélité ici pour l'instant.</div>`}
      </div>`;
    container.querySelector("#lc-new").addEventListener("click", () => V.openForm(null));
    container.querySelectorAll("[data-l]").forEach((el) =>
      el.addEventListener("click", () => V.openCard(cards.find((c) => c.id === el.dataset.l)))
    );
  };

  const refresh = () => PP.views.main.afterChange(false);

  V.openCard = (c) => {
    if (!c) return;
    let showPin = false;
    const profs = PP.state.profiles.filter((p) => c.profiles.includes(p.id));
    const m = PP.modal.open(`<div class="lc-detail"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="l-close">Fermer</button></div>`);
    m.querySelector("#l-close").addEventListener("click", () => PP.modal.close());
    const box = m.querySelector(".lc-detail");
    const none = '<span style="color:var(--faint)">—</span>';
    const draw = () => {
      box.innerHTML = `
        <div class="detail-head" style="margin-bottom:18px">
          ${PP.bankcard.logo(c, "xl")}
          <div style="min-width:0"><h2 class="selectable" style="margin:0 0 6px">${PP.esc(c.name)}</h2>
            <div class="row">${profs.map((p) => `<span class="chip" style="background:rgba(0,229,255,.1);border-color:rgba(0,229,255,.35);color:#bff8ff">${PP.esc(p.name)}</span>`).join("")}</div></div>
          <div class="acts"><button class="icon-btn" id="l-del" title="Supprimer">${PP.icon.trash}</button>
            <button class="btn btn-primary" id="l-edit">${PP.icon.edit} Modifier</button></div>
        </div>
        <div class="fields">
          <div class="fld"><div class="v"><span class="label">Identifiant</span><div class="val selectable">${c.number ? PP.esc(c.number) : none}</div></div>
            ${c.number ? `<button class="icon-btn" id="l-cn" title="Copier l'identifiant">${PP.icon.copy}</button>` : ""}</div>
          <div class="fld"><div class="v"><span class="label">Code PIN</span>
              <div class="val ${showPin ? "selectable" : "masked"}">${!c.pin ? none : showPin ? PP.esc(c.pin) : "•".repeat(Math.min(8, Math.max(4, c.pin.length)))}</div></div>
            ${c.pin ? `<button class="icon-btn" id="l-eye" title="${showPin ? "Masquer" : "Afficher"}">${showPin ? PP.icon.eyeOff : PP.icon.eye}</button>
              <button class="icon-btn" id="l-cp" title="Copier le code PIN">${PP.icon.copy}</button>` : ""}</div>
        </div>`;
      const $ = (s) => box.querySelector(s);
      if ($("#l-cn")) $("#l-cn").addEventListener("click", () => PP.copyPlain(c.number, "Identifiant"));
      if ($("#l-eye")) $("#l-eye").addEventListener("click", () => { showPin = !showPin; draw(); });
      if ($("#l-cp")) $("#l-cp").addEventListener("click", () => PP.copySecret(c.pin, "Code PIN"));
      $("#l-edit").addEventListener("click", () => V.openForm(c));
      $("#l-del").addEventListener("click", async () => {
        if (!(await PP.confirm(`Supprimer la carte « ${c.name} » ?`, "Elle sera définitivement supprimée.", { ok: "Supprimer", danger: true }))) return;
        await PP.call("delete_loyaltycard", c.id);
        PP.toast("Carte supprimée");
        await refresh();
      });
    };
    draw();
  };

  V.openForm = (card) => {
    const c = card ? { ...card } : { id: null, name: "", number: "", pin: "", image: null, profiles: [] };
    const profs = card ? new Set(c.profiles) : PP.views.form.defaultProfiles();
    const opt = '<span style="text-transform:none;letter-spacing:0">(facultatif)</span>';
    const m = PP.modal.open(`
      <h2>${card ? "Modifier la carte" : "Nouvelle carte fidélité"}</h2>
      <div class="grid2">
        <div class="field full"><label>Enseigne</label><div><input class="input" id="l-name" value="${PP.esc(c.name)}" placeholder="Ex. Leclerc, Fnac, Sephora…"></div>
          <div class="logo-hint" id="l-hint"></div></div>
        <div class="field"><label>Identifiant ${opt}</label><input class="input bc-mono" id="l-number" value="${PP.esc(c.number)}" placeholder="Numéro sous le code-barre" spellcheck="false"></div>
        <div class="field"><label>Code PIN ${opt}</label><input class="input bc-mono" id="l-pin" value="${PP.esc(c.pin)}" spellcheck="false"></div>
        <div class="full" id="l-img"></div>
        <div class="field full"><label>Profils</label><div class="checks" id="l-profs"></div></div>
      </div>
      <div class="hint" style="margin-top:12px">Sur le téléphone, l'identifiant peut être rempli en scannant le code-barre de la carte.</div>
      <div class="err" id="l-err"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="l-cancel">Annuler</button><button class="btn btn-primary" id="l-save">${PP.icon.check} Enregistrer</button></div>`);
    const $ = (s) => m.querySelector(s);
    let logo = null;
    const zone = PP.views.form.imageZone($("#l-img"), () => c.image, (v) => { c.image = v; if (logo) logo.manual(); }, () => $("#l-name").value);
    logo = PP.views.form.autoLogo($("#l-name"), c, zone, $("#l-hint"));
    PP.views.form.profileChecks($("#l-profs"), profs);
    $("#l-name").focus();
    $("#l-cancel").addEventListener("click", () => (card ? V.openCard(card) : PP.modal.close()));
    const save = async () => {
      const rec = { ...c, name: $("#l-name").value.trim(), number: $("#l-number").value.trim(), pin: $("#l-pin").value.trim(), profiles: [...profs] };
      if (!rec.name) { $("#l-err").textContent = "Indique l'enseigne de la carte."; return; }
      if (!rec.profiles.length) { $("#l-err").textContent = "Choisis au moins un profil."; return; }
      const saved = await PP.call("save_loyaltycard", rec);
      PP.toast(card ? "Carte modifiée" : "Carte ajoutée");
      await refresh();
      V.openCard(saved);
    };
    $("#l-save").addEventListener("click", save);
    m.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) save(); });
  };
})();
