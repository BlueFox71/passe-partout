/* Questions de sécurité : configuration (Réglages), récupération du code oublié (écran de verrouillage). */
(function () {
  const V = (PP.views.recovery = {});
  const COUNT = 3;

  // Réglages : choix des 3 questions et des réponses ; le code actuel est redemandé.
  V.setup = async (onDone) => {
    const { questions, chosen } = await PP.call("get_recovery");
    const sel = chosen ? [...chosen] : [0, 1, 2];
    const isPin = PP.state.lock_mode === "pin";
    const options = (i) => questions.map((q, k) => `<option value="${k}" ${k === sel[i] ? "selected" : ""}>${PP.esc(q)}</option>`).join("");
    const m = PP.modal.open(`
      <h2>Questions de sécurité</h2>
      <p style="color:var(--muted);margin:0 0 16px">Si tu oublies ton code, répondre à ces 3 questions débloquera le coffre.
        Majuscules, accents et espaces ne comptent pas.</p>
      ${[0, 1, 2].map((i) => `<div class="field rq-field"><label>Question ${i + 1}</label>
        <select class="input" data-q="${i}">${options(i)}</select>
        <input class="input" data-a="${i}" placeholder="Ta réponse" spellcheck="false" autocomplete="off"></div>`).join("")}
      <div class="warn-box" style="margin:4px 0 14px">Choisis des réponses que toi seul connais : quelqu'un qui les devine peut ouvrir ton coffre.
        Évite ce qui se trouve facilement sur les réseaux sociaux.</div>
      <div class="field"><label>${isPin ? "Ton code PIN actuel" : "Ton mot de passe actuel"}</label>
        <input class="input" id="rq-code" type="password" ${isPin ? 'inputmode="numeric" maxlength="12"' : ""} style="max-width:260px"></div>
      <div class="err" id="rq-err"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="rq-no">Annuler</button>
        <button class="btn btn-primary" id="rq-ok">${PP.icon.check} Enregistrer</button></div>`);
    const $ = (s) => m.querySelector(s);
    m.querySelector('[data-a="0"]').focus();
    $("#rq-no").addEventListener("click", () => PP.modal.close());
    $("#rq-ok").addEventListener("click", async () => {
      const qs = [0, 1, 2].map((i) => Number(m.querySelector(`[data-q="${i}"]`).value));
      const as = [0, 1, 2].map((i) => m.querySelector(`[data-a="${i}"]`).value);
      const err = $("#rq-err");
      if (new Set(qs).size !== COUNT) { err.textContent = "Choisis 3 questions différentes."; return; }
      if (as.some((a) => PP.normalize(a).replace(/[^a-z0-9]/g, "").length < 2)) { err.textContent = "Réponds aux 3 questions (au moins 2 lettres ou chiffres)."; return; }
      if (!$("#rq-code").value) { err.textContent = "Saisis ton code actuel."; return; }
      $("#rq-ok").disabled = true;
      try { await PP.call("set_recovery", qs, as, $("#rq-code").value); } catch (e) { $("#rq-ok").disabled = false; return; }
      PP.modal.close();
      await PP.refreshState();
      PP.toast("Questions de sécurité enregistrées");
      if (onDone) onDone();
    });
  };

  // Écran de verrouillage : « Code oublié ? ».
  V.forgot = async () => {
    const { questions, chosen } = await PP.call("get_recovery");
    if (!chosen) return PP.views.lock.show();
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:520px;padding:26px;display:flex;flex-direction:column;gap:14px">
          <div><h2 style="margin:0 0 6px">Code oublié</h2>
            <div style="color:var(--muted)">Réponds à tes questions de sécurité pour débloquer le coffre. Tu choisiras ensuite un nouveau code.</div></div>
          ${chosen.map((q, i) => `<div class="field"><label style="text-transform:none;letter-spacing:0;font-size:13px">${PP.esc(questions[q])}</label>
            <input class="input" data-a="${i}" spellcheck="false" autocomplete="off"></div>`).join("")}
          <div class="err" id="rc-err"></div>
          <div class="row" style="justify-content:space-between">
            <button class="btn btn-ghost" id="rc-back">Retour</button>
            <button class="btn btn-primary" id="rc-go">Débloquer</button>
          </div>
        </div>
      </div>`);
    const inputs = [...app.querySelectorAll("[data-a]")];
    inputs[0].focus();
    let timer = null;
    const go = async () => {
      const btn = app.querySelector("#rc-go");
      if (btn.disabled) return;
      btn.disabled = true;
      let r;
      try { r = await PP.call("recover", inputs.map((x) => x.value)); } finally { btn.disabled = false; }
      if (r.ok) { PP.state.locked = false; return V.newCode(); }
      const err = app.querySelector("#rc-err");
      if (r.error === "no_recovery") { err.textContent = "Aucune question de sécurité n'est enregistrée."; return; }
      let left = r.wait_seconds;
      clearInterval(timer);
      const tick = () => {
        err.textContent = left > 0 ? `Une réponse est incorrecte. Réessaie dans ${left} s.` : "Une réponse est incorrecte.";
        if (left-- <= 0) clearInterval(timer);
      };
      tick();
      timer = setInterval(tick, 1000);
    };
    inputs.forEach((x) => x.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); }));
    app.querySelector("#rc-go").addEventListener("click", go);
    app.querySelector("#rc-back").addEventListener("click", () => { clearInterval(timer); PP.views.lock.show(); });
  };

  // Après une récupération : nouveau code obligatoire (écran plein, pas de fermeture possible).
  V.newCode = () => {
    let mode = PP.state.lock_mode === "password" ? "password" : "pin";
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:520px;padding:26px;display:flex;flex-direction:column;gap:14px">
          <div><h2 style="margin:0 0 6px">Choisis un nouveau code</h2>
            <div style="color:var(--muted)">Coffre débloqué. Choisis un nouveau code pour le protéger : tes questions de sécurité restent valables.</div></div>
          <div class="seg" id="nc-mode"><button data-m="pin">Code PIN</button><button data-m="password">Mot de passe</button></div>
          <div id="nc-f" style="display:grid;grid-template-columns:1fr 1fr;gap:12px"></div>
          <div class="err" id="nc-err"></div>
          <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="nc-go">${PP.icon.check} Enregistrer</button></div>
        </div>
      </div>`);
    const draw = () => {
      app.querySelectorAll("#nc-mode [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
      const attrs = mode === "pin" ? 'inputmode="numeric" maxlength="12"' : "";
      app.querySelector("#nc-f").innerHTML = `
        <div class="field"><label>${mode === "pin" ? "Nouveau code PIN" : "Nouveau mot de passe"}</label><input class="input" id="nc-1" type="password" ${attrs}></div>
        <div class="field"><label>Confirmer</label><input class="input" id="nc-2" type="password" ${attrs}></div>`;
      app.querySelector("#nc-1").focus();
    };
    app.querySelectorAll("#nc-mode [data-m]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.m; draw(); }));
    draw();
    const save = async () => {
      const a = app.querySelector("#nc-1").value, b = app.querySelector("#nc-2").value;
      const err = app.querySelector("#nc-err");
      if (mode === "pin" && !/^[0-9]{4,12}$/.test(a)) { err.textContent = "Le PIN doit contenir de 4 à 12 chiffres."; return; }
      if (mode === "password" && a.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères."; return; }
      if (a !== b) { err.textContent = "Les deux saisies ne correspondent pas."; return; }
      await PP.call("set_lock", mode, a);
      PP.toast("Nouveau code enregistré");
      PP.route();
    };
    app.querySelector("#nc-go").addEventListener("click", save);
    app.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("#nc-2")) save(); });
  };
})();
