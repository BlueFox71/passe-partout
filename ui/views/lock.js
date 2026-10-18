/* Écran de verrouillage : pavé PIN ou mot de passe, délai après erreurs, restauration si fichier abîmé. */
(function () {
  const V = (PP.views.lock = {});
  let code = "";
  let waitTimer = null;
  let press = null; // pavé PIN affiché actuellement (null sinon)

  // Un seul écouteur clavier pour toute la session : réafficher l'écran ne doit pas doubler les touches.
  window.addEventListener("keydown", (e) => {
    if (!press || !document.getElementById("dots")) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
    else if (e.key === "Enter") { e.preventDefault(); press("ok"); }
  });

  V.show = async () => {
    code = "";
    press = null;
    const s = PP.state;
    if (s.corrupt) return V.showCorrupt();
    const isPin = s.lock_mode === "pin";
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="lock-card glass">
          <div style="color:var(--muted)">${isPin ? "Entre ton code PIN" : s.lock_mode === "unknown" ? "Entre ton code PIN ou ton mot de passe" : "Entre ton mot de passe"}</div>
          ${isPin
            ? `<div class="pin-dots" id="dots"></div>
               <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
                 <button data-k="del" title="Effacer">⌫</button><button data-k="0">0</button>
                 <button data-k="ok" title="Valider" style="color:var(--pink)">✓</button></div>`
            : `<div class="pw-wrap" style="width:100%"><input id="pw" class="input" type="password" autofocus placeholder="${s.lock_mode === "unknown" ? "Code" : "Mot de passe"}"></div>
               <button class="btn btn-primary" id="go" style="width:100%;justify-content:center">Déverrouiller</button>`}
          <div class="err" id="err"></div>
          ${isPin && !Number(s.pin_length) ? `<div class="hint" style="text-align:center">Valide avec ✓ cette fois-ci :<br>ensuite, le code se validera tout seul.</div>` : ""}
          ${s.mock ? `<div class="hint">Maquette : le code est 123456</div>` : ""}
        </div>
        <a href="#" id="restore-link" class="hint" style="color:var(--faint)">Problème d'accès ? Restaurer une sauvegarde</a>
      </div>`);

    const err = app.querySelector("#err");
    app.querySelector("#restore-link").addEventListener("click", (e) => { e.preventDefault(); V.showCorrupt(true); });
    const card = app.querySelector(".lock-card");

    let busy = false;
    const submit = async (value) => {
      if (!value || busy) return;
      busy = true;
      let r;
      try { r = await PP.call("unlock", value); } finally { busy = false; }
      if (r.ok) { PP.state.locked = false; press = null; return PP.route(); }
      code = "";
      drawDots();
      card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
      if (r.error === "corrupt") { PP.state.corrupt = true; return V.showCorrupt(); }
      startWait(r.wait_seconds);
      const pw = app.querySelector("#pw");
      if (pw) { pw.value = ""; pw.focus(); }
    };

    const startWait = (secs) => {
      clearInterval(waitTimer);
      let left = secs;
      const tick = () => {
        if (left <= 0) { clearInterval(waitTimer); err.textContent = "Code incorrect."; return; }
        err.textContent = `Code incorrect. Réessaie dans ${left} s.`;
        left--;
      };
      tick();
      waitTimer = setInterval(tick, 1000);
    };

    const pinLength = Number(s.pin_length) || 0; // connue : validation automatique dès le dernier chiffre
    const drawDots = () => {
      const d = app.querySelector("#dots");
      if (!d) return;
      // longueur inconnue : seulement les chiffres tapés (pas de cases vides qui suggéreraient 6 chiffres)
      const n = pinLength || code.length;
      d.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < code.length ? "f" : ""}"></i>`).join("");
    };

    if (isPin) {
      drawDots();
      press = (k) => {
        if (busy) return;
        if (k === "del") code = code.slice(0, -1);
        else if (k === "ok") return submit(code);
        else if (code.length < (pinLength || 12)) code += k;
        drawDots();
        if (pinLength && code.length === pinLength) submit(code);
      };
      app.querySelectorAll("[data-k]").forEach((b) => {
        b.tabIndex = -1;
        // pas de focus sur le bouton : sinon Entrée « recliquerait » le dernier chiffre
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => press(b.dataset.k));
      });
    } else {
      const pw = app.querySelector("#pw");
      pw.focus();
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(pw.value); });
      app.querySelector("#go").addEventListener("click", () => submit(pw.value));
    }
  };

  V.showCorrupt = async (fromLock = false) => {
    press = null;
    const backups = await PP.call("list_backups");
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:480px;padding:26px">
          <h2 style="margin:0 0 8px">${fromLock ? "Restaurer une sauvegarde" : "Le fichier de données est illisible"}</h2>
          <p style="color:var(--muted);margin:0 0 16px">${fromLock ? "Si ton code ne fonctionne plus parce que le fichier a été abîmé" : "Il a peut-être été abîmé ou modifié. Tu peux restaurer"}
            une sauvegarde automatique : la plus récente est en haut. Il faudra ensuite saisir le code de cette sauvegarde.</p>
          ${backups.length
            ? backups.map((b) => `<div class="prof-row"><div style="flex:1">${PP.esc(b.date)}</div>
                <button class="btn btn-ghost" data-b="${PP.esc(b.name)}">Restaurer</button></div>`).join("")
            : `<div class="warn-box">Aucune sauvegarde disponible.</div>`}
          ${fromLock ? `<div style="margin-top:16px"><button class="btn btn-ghost" id="back">Retour</button></div>` : ""}
        </div>
      </div>`);
    const back = app.querySelector("#back");
    if (back) back.addEventListener("click", () => V.show());
    app.querySelectorAll("[data-b]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await PP.confirm("Restaurer cette sauvegarde ?", "Les modifications faites après cette date seront perdues.", { ok: "Restaurer" }))) return;
        await PP.call("restore_backup", b.dataset.b);
        PP.state.corrupt = false;
        PP.toast("Sauvegarde restaurée");
        PP.route();
      })
    );
  };
})();
