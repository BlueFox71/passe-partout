/* Cartes cadeaux : tuiles, fiche (code/PIN, dépenses, historique), formulaire. */
(function () {
  const V = (PP.views.giftcards = {});
  const S = PP.state;
  let showDone = false;

  const isFinished = (g) => g.remaining <= 0 || (g.end_date && g.end_date < PP.todayIso());

  V.render = (container, cards) => {
    const active = cards.filter((g) => !isFinished(g)).sort((a, b) => (a.end_date || "9999").localeCompare(b.end_date || "9999"));
    const done = cards.filter(isFinished);
    const total = active.reduce((s, g) => s + g.remaining, 0);
    container.innerHTML = `
      <div class="gc-wrap">
        <div class="list-head" style="padding:0 0 16px"><div><h2>Cartes cadeaux</h2>
          <small>${active.length} active${active.length > 1 ? "s" : ""} · ${PP.money(total)} disponibles</small></div>
          <button class="btn btn-primary" id="gc-new">${PP.icon.plus} Nouvelle carte</button></div>
        ${active.length ? `<div class="gc-grid">${active.map(tile).join("")}</div>`
          : `<div class="empty"><div class="big">🎁</div>Aucune carte cadeau active.</div>`}
        ${done.length ? `<div class="section-toggle" id="gc-done">${showDone ? "▾" : "▸"} Terminées (${done.length})</div>
          ${showDone ? `<div class="gc-grid">${done.map(tile).join("")}</div>` : ""}` : ""}
      </div>`;
    container.querySelector("#gc-new").addEventListener("click", () => V.openForm(null));
    const t = container.querySelector("#gc-done");
    if (t) t.addEventListener("click", () => { showDone = !showDone; V.render(container, cards); });
    container.querySelectorAll("[data-g]").forEach((el) =>
      el.addEventListener("click", () => V.openCard(cards.find((g) => g.id === el.dataset.g)))
    );
  };

  function endLabel(g) {
    if (!g.end_date) return `<div class="end">Sans date de fin</div>`;
    const d = PP.daysUntil(g.end_date);
    if (d < 0) return `<div class="end">Expirée le ${PP.dateFr(g.end_date)}</div>`;
    const soon = d <= 30;
    return `<div class="end ${soon ? "soon" : ""}">${soon ? "⏰ " : ""}Expire le ${PP.dateFr(g.end_date)}${soon ? ` (dans ${d} j)` : ""}</div>`;
  }

  function tile(g) {
    return `<div class="gc ${isFinished(g) ? "done" : ""}" data-g="${g.id}">
      <div class="top">${PP.logo(g)}<b style="font-size:16px">${PP.esc(g.name)}</b></div>
      <div class="amount">${PP.money(g.remaining)}</div>
      ${g.initial ? `<div class="hint">sur ${PP.money(g.initial)}</div>` : ""}
      ${endLabel(g)}
    </div>`;
  }

  async function refresh() {
    await PP.views.main.afterChange(false);
  }

  V.openCard = (g) => {
    let showCode = false, showPin = false;
    const draw = () => {
      const m = PP.modal.open(`
        <div class="detail-head" style="margin-bottom:18px">
          ${PP.logo(g, "xl")}
          <div><h2 style="margin:0 0 4px">${PP.esc(g.name)}</h2>${endLabel(g)}</div>
          <div class="acts"><button class="icon-btn" id="g-del" title="Supprimer">${PP.icon.trash}</button>
            <button class="icon-btn" id="g-edit" title="Modifier">${PP.icon.edit}</button></div>
        </div>
        <div class="gc" style="cursor:default;margin-bottom:16px"><div class="hint">Solde restant</div>
          <div class="amount" style="margin-top:4px">${PP.money(g.remaining)}</div>
          ${g.initial ? `<div class="hint">sur ${PP.money(g.initial)}</div>` : ""}</div>
        <div class="fields">
          ${secretRow("Code", g.code, showCode, "code")}
          ${g.pin ? secretRow("PIN", g.pin, showPin, "pin") : ""}
        </div>
        <div class="row" style="margin-top:16px">
          <input class="input" id="g-amt" type="number" min="0" step="0.01" placeholder="Montant dépensé (€)" style="max-width:220px" ${g.remaining > 0 ? "" : "disabled"}>
          <button class="btn btn-primary" id="g-spend" ${g.remaining > 0 ? "" : "disabled"}>J'ai dépensé…</button>
        </div>
        <div class="err" id="g-err"></div>
        ${g.history && g.history.length ? `<div class="history"><div class="label" style="border:0">Historique</div>
          ${[...g.history].reverse().map((h) => `<div><span>${PP.dateFr(h.date)}</span><span>− ${PP.money(h.amount)}</span></div>`).join("")}</div>` : ""}
        <div class="modal-foot"><button class="btn btn-ghost" id="g-close">Fermer</button></div>`);
      const $ = (s) => m.querySelector(s);
      $("#g-close").addEventListener("click", () => PP.modal.close());
      m.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => {
        if (b.dataset.eye === "code") showCode = !showCode; else showPin = !showPin;
        draw();
      }));
      m.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () =>
        PP.copySecret(b.dataset.copy === "code" ? g.code : g.pin, b.dataset.copy === "code" ? "Code" : "PIN")
      ));
      $("#g-spend").addEventListener("click", async () => {
        const v = parseFloat(String($("#g-amt").value).replace(",", "."));
        if (!(v > 0)) { $("#g-err").textContent = "Indique un montant positif."; return; }
        if (v > g.remaining + 1e-9) { $("#g-err").textContent = "C'est plus que le solde restant."; return; }
        g = await PP.call("spend", g.id, v);
        PP.toast(`Nouveau solde : ${PP.money(g.remaining)}`);
        await refresh();
        draw();
      });
      $("#g-amt").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#g-spend").click(); });
      $("#g-edit").addEventListener("click", () => V.openForm(g));
      $("#g-del").addEventListener("click", async () => {
        if (!(await PP.confirm(`Supprimer la carte « ${g.name} » ?`, "Elle sera définitivement supprimée.", { ok: "Supprimer", danger: true }))) return;
        await PP.call("delete_giftcard", g.id);
        PP.toast("Carte supprimée");
        await refresh();
      });
    };
    draw();
  };

  function secretRow(label, value, shown, key) {
    return `<div class="fld"><div class="v"><span class="label">${label}</span>
      <div class="val ${shown ? "selectable" : "masked"}">${shown ? PP.esc(value) : "•".repeat(Math.min(16, Math.max(4, String(value).length)))}</div></div>
      <button class="icon-btn" data-eye="${key}" title="${shown ? "Masquer" : "Afficher"}">${shown ? PP.icon.eyeOff : PP.icon.eye}</button>
      <button class="icon-btn" data-copy="${key}" title="Copier">${PP.icon.copy}</button></div>`;
  }

  V.openForm = (card) => {
    const g = card ? { ...card } : { id: null, name: "", code: "", pin: "", initial: null, remaining: 0, end_date: null, image: null, profiles: [], history: [] };
    const profs = card ? new Set(g.profiles) : PP.views.form.defaultProfiles();
    const m = PP.modal.open(`
      <h2>${card ? "Modifier la carte" : "Nouvelle carte cadeau"}</h2>
      <div class="grid2">
        <div class="field full"><label>Enseigne / nom</label><input class="input" id="c-name" value="${PP.esc(g.name)}" placeholder="Ex. Fnac"></div>
        <div class="field"><label>Code</label><input class="input" id="c-code" value="${PP.esc(g.code)}" spellcheck="false"></div>
        <div class="field"><label>PIN</label><input class="input" id="c-pin" value="${PP.esc(g.pin || "")}" spellcheck="false"></div>
        <div class="field"><label>Montant initial (€)</label><input class="input" id="c-init" type="number" step="0.01" min="0" value="${g.initial ?? ""}"></div>
        <div class="field"><label>Montant restant (€)</label><input class="input" id="c-rem" type="number" step="0.01" min="0" value="${card ? g.remaining : ""}"></div>
        <div class="field"><label>Date de fin <span style="text-transform:none;letter-spacing:0">(facultatif)</span></label><input class="input" id="c-end" type="date" value="${g.end_date || ""}"></div>
        <div></div>
        <div class="full" id="c-img"></div>
        <div class="field full"><label>Profils</label><div class="checks" id="c-profs"></div></div>
      </div>
      <div class="err" id="c-err"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="c-cancel">Annuler</button><button class="btn btn-primary" id="c-save">${PP.icon.check} Enregistrer</button></div>`);
    const $ = (s) => m.querySelector(s);
    PP.views.form.imageZone($("#c-img"), () => g.image, (v) => (g.image = v), () => $("#c-name").value);
    PP.views.form.profileChecks($("#c-profs"), profs);
    $("#c-name").focus();
    $("#c-init").addEventListener("input", () => { if (!card && !$("#c-rem").dataset.touched) $("#c-rem").value = $("#c-init").value; });
    $("#c-rem").addEventListener("input", () => ($("#c-rem").dataset.touched = "1"));
    $("#c-cancel").addEventListener("click", () => PP.modal.close());
    $("#c-save").addEventListener("click", async () => {
      const num = (s) => (String(s).trim() === "" ? null : Math.round(parseFloat(String(s).replace(",", ".")) * 100) / 100);
      const rec = {
        ...g,
        name: $("#c-name").value.trim(),
        code: $("#c-code").value.trim(),
        pin: $("#c-pin").value.trim(),
        initial: num($("#c-init").value),
        remaining: num($("#c-rem").value) ?? 0,
        end_date: $("#c-end").value || null,
        profiles: [...profs],
      };
      if (!rec.name) { $("#c-err").textContent = "Le nom est obligatoire."; return; }
      if (rec.remaining < 0 || (rec.initial != null && rec.initial < 0)) { $("#c-err").textContent = "Les montants ne peuvent pas être négatifs."; return; }
      if (!rec.profiles.length) { $("#c-err").textContent = "Choisis au moins un profil."; return; }
      await PP.call("save_giftcard", rec);
      PP.modal.close();
      PP.toast(card ? "Carte modifiée" : "Carte ajoutée");
      await refresh();
    });
  };
})();
