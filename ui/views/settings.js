/* Réglages : verrou, verrouillage automatique, profils, import Excel, sauvegardes. */
(function () {
  const V = (PP.views.settings = {});
  const S = PP.state;

  V.render = async (container) => {
    const backups = await PP.call("list_backups");
    const modeLabel = { none: "Aucun", pin: "Code PIN", password: "Mot de passe" };
    container.innerHTML = `
      <div class="settings">
        <h2>Réglages</h2>

        <div class="card glass">
          <h3>🔒 Verrou</h3>
          <p>Actuellement : <b style="color:var(--text)">${modeLabel[S.lock_mode]}</b>. Avec un verrou, toutes tes données sont chiffrées sur le disque.</p>
          <div class="seg" id="lk">${["none", "pin", "password"].map((m) => `<button data-m="${m}" class="${m === S.lock_mode ? "on" : ""}">${modeLabel[m]}</button>`).join("")}</div>
          <div id="lk-form" style="margin-top:14px"></div>
        </div>

        <div class="card glass">
          <h3>⏱ Verrouillage automatique</h3>
          <p>Le coffre se verrouille après un temps sans activité, et quand tu verrouilles Windows.</p>
          <select class="input" id="al" style="max-width:240px" ${S.lock_mode === "none" ? "disabled" : ""}>
            ${[[1, "1 minute"], [5, "5 minutes"], [10, "10 minutes"], [30, "30 minutes"], [60, "1 heure"], [0, "Jamais"]]
              .map(([v, l]) => `<option value="${v}" ${Number(S.settings.autolock_minutes) === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
          ${S.lock_mode === "none" ? `<div class="hint" style="margin-top:8px">Disponible quand un verrou est défini.</div>` : ""}
        </div>

        <div class="card glass">
          <h3>👥 Profils</h3>
          <p>Les profils servent à ranger les comptes (par exemple un pour chaque personne du couple).</p>
          ${S.profiles.map((p) => `<div class="prof-row">${PP.avatar(p)}<div style="flex:1;font-weight:600">${PP.esc(p.name)}</div>
            <button class="btn btn-ghost" data-pe="${p.id}" style="padding:6px 12px">${PP.icon.edit} Modifier</button>
            ${S.profiles.length > 1 ? `<button class="icon-btn" data-pd="${p.id}" title="Supprimer">${PP.icon.trash}</button>` : ""}</div>`).join("")}
          <div style="margin-top:12px"><button class="btn btn-ghost" id="padd">${PP.icon.plus} Ajouter un profil</button></div>
        </div>

        <div class="card glass">
          <h3>📥 Importer un fichier Excel</h3>
          <p>Ajoute les comptes d'un fichier .xlsx (colonnes Type, Support, Identifiant, Mot de passe). Les comptes déjà présents ne sont ni modifiés ni dupliqués.</p>
          <button class="btn btn-ghost" id="imp">Choisir un fichier…</button>
        </div>

        <div class="card glass">
          <h3>🛟 Sauvegardes automatiques</h3>
          <p>Les 5 dernières versions sont conservées à chaque enregistrement${S.lock_mode !== "none" ? ", chiffrées comme le reste" : ""}.</p>
          ${backups.length ? backups.map((b) => `<div class="prof-row"><div style="flex:1">${PP.esc(b.date)}</div>
            <button class="btn btn-ghost" data-b="${PP.esc(b.name)}" style="padding:6px 12px">Restaurer</button></div>`).join("")
            : `<div class="hint">Aucune sauvegarde pour l'instant.</div>`}
        </div>
      </div>`;

    const $ = (s) => container.querySelector(s);
    container.querySelectorAll("#lk [data-m]").forEach((b) => b.addEventListener("click", () => lockForm(container, b.dataset.m)));
    $("#al").addEventListener("change", async () => {
      S.settings = await PP.call("save_settings", { autolock_minutes: Number($("#al").value) });
      PP.toast("Réglage enregistré");
    });
    container.querySelectorAll("[data-pe]").forEach((b) => b.addEventListener("click", async () => {
      const p = await PP.views.profiles.edit(S.profiles.find((x) => x.id === b.dataset.pe));
      if (p) { await PP.refreshState(); PP.views.main.show(); }
    }));
    container.querySelectorAll("[data-pd]").forEach((b) => b.addEventListener("click", () => deleteProfile(b.dataset.pd)));
    $("#padd").addEventListener("click", async () => {
      const p = await PP.views.profiles.edit(null);
      if (p) { await PP.refreshState(); PP.views.main.show(); }
    });
    $("#imp").addEventListener("click", importExcel);
    container.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", async () => {
      if (!(await PP.confirm("Restaurer cette sauvegarde ?", "Les modifications faites après cette date seront perdues (l'état actuel est lui-même sauvegardé avant).", { ok: "Restaurer" }))) return;
      await PP.call("restore_backup", b.dataset.b);
      PP.toast("Sauvegarde restaurée");
      PP.route();
    }));
  };

  function lockForm(container, mode) {
    container.querySelectorAll("#lk [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
    const f = container.querySelector("#lk-form");
    if (mode === S.lock_mode && mode === "none") { f.innerHTML = ""; return; }
    if (mode === "none") {
      f.innerHTML = `<div class="warn-box">Sans verrou, le fichier de données sera enregistré en clair sur ton PC.</div>
        <div class="row" style="margin-top:12px"><button class="btn btn-danger" id="lk-go">Retirer le verrou</button></div>`;
    } else {
      const isPin = mode === "pin";
      f.innerHTML = `
        <div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:520px">
          <div class="field"><label>${isPin ? "Nouveau code PIN" : "Nouveau mot de passe"}</label>
            <input class="input" id="lk-1" type="password" ${isPin ? 'inputmode="numeric" maxlength="12"' : ""}></div>
          <div class="field"><label>Confirmer</label><input class="input" id="lk-2" type="password" ${isPin ? 'inputmode="numeric" maxlength="12"' : ""}></div>
        </div>
        <div class="warn-box" style="margin-top:12px">${isPin
          ? "Un PIN d'au moins 6 chiffres est conseillé : un PIN court se devine bien plus vite qu'un mot de passe. "
          : ""}<b>Attention :</b> si tu oublies ce code, tes données ne pourront pas être récupérées.</div>
        <div class="err" id="lk-err"></div>
        <div class="row"><button class="btn btn-primary" id="lk-go">${S.lock_mode === "none" ? "Activer le verrou" : "Changer le code"}</button></div>`;
      f.querySelector("#lk-1").focus();
    }
    f.querySelector("#lk-go").addEventListener("click", async () => {
      if (mode === "none") {
        await PP.call("set_lock", "none", null);
      } else {
        const a = f.querySelector("#lk-1").value, b = f.querySelector("#lk-2").value;
        const err = f.querySelector("#lk-err");
        if (mode === "pin" && !/^[0-9]{4,12}$/.test(a)) { err.textContent = "Le PIN doit contenir de 4 à 12 chiffres."; return; }
        if (mode === "password" && a.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères."; return; }
        if (a !== b) { err.textContent = "Les deux saisies ne correspondent pas."; return; }
        await PP.call("set_lock", mode, a);
      }
      await PP.refreshState();
      PP.toast(mode === "none" ? "Verrou retiré" : "Verrou enregistré, données chiffrées");
      PP.views.main.show();
    });
  }

  async function deleteProfile(id) {
    const p = S.profiles.find((x) => x.id === id);
    const others = S.profiles.filter((x) => x.id !== id);
    const m = PP.modal.open(`
      <h2>Supprimer le profil « ${PP.esc(p.name)} » ?</h2>
      <p style="color:var(--muted);margin:0 0 14px">Aucun compte n'est supprimé. Les comptes et cartes qui n'appartiennent qu'à ce profil seront rattachés à :</p>
      <select class="input" id="ra">${others.map((o) => `<option value="${o.id}">${PP.esc(o.name)}</option>`).join("")}</select>
      <div class="modal-foot"><button class="btn btn-ghost" id="no">Annuler</button><button class="btn btn-danger" id="ok">Supprimer le profil</button></div>`, { cls: "sm" });
    m.querySelector("#no").addEventListener("click", () => PP.modal.close());
    m.querySelector("#ok").addEventListener("click", async () => {
      await PP.call("delete_profile", id, m.querySelector("#ra").value);
      PP.modal.close();
      if (S.profileId === id) S.profileId = null;
      await PP.refreshState();
      PP.toast("Profil supprimé");
      PP.views.main.show();
    });
  }

  async function importExcel() {
    const cur = S.profiles.find((p) => p.id === S.profileId) || S.profiles[0];
    const r = await PP.call("import_excel", null, cur.name);
    if (!r) return;
    PP.toast(`${r.added} compte(s) ajouté(s), ${r.skipped} déjà présent(s)`, { seconds: 5 });
    await PP.views.main.afterChange();
  }
})();
