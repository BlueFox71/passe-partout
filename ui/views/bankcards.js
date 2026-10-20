/* Cartes bancaires : cartes dessinées (société, titulaire, 4 derniers chiffres, expiration, réseau),
   fiche avec un bouton copier par champ (code et cryptogramme masqués), formulaire. */
(function () {
  const V = (PP.views.bankcards = {});

  const BC = PP.bankcard; // dessin et mise en forme, partagés avec le téléphone (ui/app.js)
  const digits = BC.digits;

  V.render = (container, cards) => {
    container.innerHTML = `
      <div class="gc-wrap">
        <div class="list-head" style="padding:0 0 16px"><div><h2>Cartes bancaires</h2>
          <small>${cards.length} carte${cards.length > 1 ? "s" : ""}</small></div>
          <button class="btn btn-primary" id="bc-new">${PP.icon.plus} Nouvelle carte</button></div>
        ${cards.length ? `<div class="bc-grid">${cards.map((b) => `<div class="bc-item" data-b="${PP.esc(b.id)}">${BC.visual(b)}</div>`).join("")}</div>`
          : `<div class="empty"><div class="big">💳</div>Aucune carte bancaire ici pour l'instant.</div>`}
      </div>`;
    container.querySelector("#bc-new").addEventListener("click", () => V.openForm(null));
    container.querySelectorAll("[data-b]").forEach((el) =>
      el.addEventListener("click", () => V.openCard(cards.find((b) => b.id === el.dataset.b)))
    );
  };

  const refresh = () => PP.views.main.afterChange(false);

  V.openCard = (b) => {
    if (!b) return;
    const shown = { cvv: false, pin: false };
    const profs = PP.state.profiles.filter((p) => b.profiles.includes(p.id));
    // [clé, libellé, valeur affichée, secret (masqué + copie effacée après 30 s), texte copié]
    const rows = () => [
      ["number", "Numéro", BC.formatNumber(b.number), false, digits(b.number), true],
      ["expiry", "Expiration", b.expiry, false, b.expiry],
      ["cvv", "Cryptogramme", b.cvv, true, b.cvv],
      ["pin", "Code", b.pin, true, b.pin],
      ["holder", "Titulaire", b.holder, false, b.holder],
    ];
    const m = PP.modal.open(`<div class="bc-detail"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="b-close">Fermer</button></div>`, { cls: "wide" });
    m.querySelector("#b-close").addEventListener("click", () => PP.modal.close());
    const box = m.querySelector(".bc-detail");
    const draw = () => {
      box.innerHTML = `
        <div class="detail-head" style="margin-bottom:18px">
          ${BC.logo(b, "xl")}
          <div style="min-width:0"><h2 class="selectable" style="margin:0 0 6px">${PP.esc(b.name)}</h2>
            <div class="row">${profs.map((p) => `<span class="chip" style="background:rgba(0,229,255,.1);border-color:rgba(0,229,255,.35);color:#bff8ff">${PP.esc(p.name)}</span>`).join("")}</div></div>
          <div class="acts"><button class="icon-btn" id="b-del" title="Supprimer">${PP.icon.trash}</button>
            <button class="btn btn-primary" id="b-edit">${PP.icon.edit} Modifier</button></div>
        </div>
        <div class="bc-cols">
          ${BC.visual(b, true)}
          <div class="fields bc-fields">${rows().map(([key, label, value, secret, , sensitive]) => {
            const hide = secret && !shown[key];
            const val = !value ? '<span style="color:var(--faint)">—</span>'
              : hide ? "•".repeat(Math.min(8, Math.max(3, String(value).length))) : PP.esc(value);
            return `<div class="fld"><div class="v"><span class="label">${label}</span>
                <div class="val ${hide ? "masked" : "selectable"}">${val}</div></div>
              ${secret && value ? `<button class="icon-btn" data-eye="${key}" title="${shown[key] ? "Masquer" : "Afficher"}">${shown[key] ? PP.icon.eyeOff : PP.icon.eye}</button>` : ""}
              ${value ? `<button class="icon-btn" data-copy="${key}" title="Copier${key === "number" ? " (sans espaces)" : ""}">${PP.icon.copy}</button>` : ""}</div>`;
          }).join("")}</div>
        </div>`;
      box.querySelectorAll("[data-eye]").forEach((x) => x.addEventListener("click", () => { shown[x.dataset.eye] = !shown[x.dataset.eye]; draw(); }));
      box.querySelectorAll("[data-copy]").forEach((x) => x.addEventListener("click", () => {
        const [, label, , secret, text, sensitive] = rows().find((r) => r[0] === x.dataset.copy);
        if (secret || sensitive) PP.copySecret(text, label); else PP.copyPlain(text, label);
      }));
      box.querySelector("#b-edit").addEventListener("click", () => V.openForm(b));
      box.querySelector("#b-del").addEventListener("click", async () => {
        if (!(await PP.confirm(`Supprimer la carte « ${b.name} » ?`, "Elle sera définitivement supprimée.", { ok: "Supprimer", danger: true }))) return;
        await PP.call("delete_bankcard", b.id);
        PP.toast("Carte supprimée");
        await refresh();
      });
    };
    draw();
  };

  V.openForm = (card) => {
    const b = card ? { ...card } : { id: null, name: "", holder: "", number: "", expiry: "", cvv: "", pin: "", image: null, profiles: [] };
    const profs = card ? new Set(b.profiles) : PP.views.form.defaultProfiles();
    const m = PP.modal.open(`
      <h2>${card ? "Modifier la carte" : "Nouvelle carte bancaire"}</h2>
      <div class="grid2">
        <div class="field"><label>Société</label><div><input class="input" id="b-name" value="${PP.esc(b.name)}" placeholder="Ex. Boursorama, Crédit Agricole…"></div>
          <div class="logo-hint" id="b-hint"></div></div>
        <div class="field"><label>Titulaire</label><input class="input" id="b-holder" value="${PP.esc(b.holder)}" placeholder="Nom inscrit sur la carte"></div>
        <div class="field full"><label>Numéro</label><input class="input bc-mono" id="b-number" value="${PP.esc(BC.formatNumber(b.number))}" inputmode="numeric" placeholder="1234 5678 9012 3456" spellcheck="false"></div>
        <div class="field"><label>Expiration</label><input class="input bc-mono" id="b-expiry" value="${PP.esc(b.expiry)}" inputmode="numeric" placeholder="MM/AA" maxlength="5"></div>
        <div class="field"><label>Cryptogramme</label><input class="input bc-mono" id="b-cvv" value="${PP.esc(b.cvv)}" inputmode="numeric" placeholder="3 chiffres au dos" maxlength="4" spellcheck="false"></div>
        <div class="field"><label>Code</label><input class="input bc-mono" id="b-pin" value="${PP.esc(b.pin)}" inputmode="numeric" placeholder="Code de la carte" spellcheck="false"></div>
        <div></div>
        <div class="full" id="b-img"></div>
        <div class="field full"><label>Profils</label><div class="checks" id="b-profs"></div></div>
      </div>
      <div class="err" id="b-err"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="b-cancel">Annuler</button><button class="btn btn-primary" id="b-save">${PP.icon.check} Enregistrer</button></div>`);
    const $ = (s) => m.querySelector(s);
    let logo = null;
    const zone = PP.views.form.imageZone($("#b-img"), () => b.image, (v) => { b.image = v; if (logo) logo.manual(); }, () => $("#b-name").value);
    logo = PP.views.form.autoLogo($("#b-name"), b, zone, $("#b-hint"));
    PP.views.form.profileChecks($("#b-profs"), profs);
    // numéro groupé par 4 et « / » de l'expiration posés pendant la frappe (seulement en fin de saisie)
    $("#b-number").addEventListener("input", (e) => {
      const el = e.target;
      if (el.selectionStart === el.value.length && /^[\d\s-]*$/.test(el.value)) el.value = BC.formatNumber(el.value);
    });
    $("#b-expiry").addEventListener("input", (e) => {
      const el = e.target;
      if (e.inputType !== "deleteContentBackward" && /^\d{2}$/.test(el.value)) el.value += "/";
    });
    $("#b-name").focus();
    $("#b-cancel").addEventListener("click", () => (card ? V.openCard(card) : PP.modal.close()));
    const save = async () => {
      const rec = {
        ...b,
        name: $("#b-name").value.trim(),
        holder: $("#b-holder").value.trim(),
        number: BC.formatNumber($("#b-number").value.trim()),
        expiry: $("#b-expiry").value.trim(),
        cvv: $("#b-cvv").value.trim(),
        pin: $("#b-pin").value.trim(),
        profiles: [...profs],
      };
      if (!rec.name) { $("#b-err").textContent = "Indique la société de la carte."; return; }
      if (!rec.profiles.length) { $("#b-err").textContent = "Choisis au moins un profil."; return; }
      const saved = await PP.call("save_bankcard", rec);
      PP.toast(card ? "Carte modifiée" : "Carte ajoutée");
      await refresh();
      V.openCard(saved);
    };
    $("#b-save").addEventListener("click", save);
    m.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) save(); });
  };
})();
