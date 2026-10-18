/* Écran de verrouillage : pavé PIN ou mot de passe, délai après erreurs, restauration si fichier abîmé. */
(function () {
  const V = (PP.views.lock = {});
  let code = "";
  let waitTimer = null;

  V.show = async () => {
    code = "";
    const s = PP.state;
    if (s.corrupt) return V.showCorrupt();
    const isPin = s.lock_mode === "pin";
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="lock-card glass">
          <div style="color:var(--muted)">${isPin ? "Entre ton code PIN" : "Entre ton mot de passe"}</div>
          ${isPin
            ? `<div class="pin-dots" id="dots"></div>
               <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join("")}
                 <button data-k="del" title="Effacer">⌫</button><button data-k="0">0</button>
                 <button data-k="ok" title="Valider" style="color:var(--pink)">✓</button></div>`
            : `<div class="pw-wrap" style="width:100%"><input id="pw" class="input" type="password" autofocus placeholder="Mot de passe"></div>
               <button class="btn btn-primary" id="go" style="width:100%;justify-content:center">Déverrouiller</button>`}
          <div class="err" id="err"></div>
          ${s.mock ? `<div class="hint">Maquette : le code est 123456</div>` : ""}
        </div>
      </div>`);

    const err = app.querySelector("#err");
    const card = app.querySelector(".lock-card");

    const submit = async (value) => {
      if (!value) return;
      const r = await PP.call("unlock", value);
      if (r.ok) { PP.state.locked = false; return PP.route(); }
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

    const drawDots = () => {
      const d = app.querySelector("#dots");
      if (!d) return;
      const n = Math.max(6, code.length);
      d.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < code.length ? "f" : ""}"></i>`).join("");
    };

    if (isPin) {
      drawDots();
      const press = (k) => {
        if (k === "del") code = code.slice(0, -1);
        else if (k === "ok") return submit(code);
        else if (code.length < 12) code += k;
        drawDots();
      };
      app.querySelectorAll("[data-k]").forEach((b) => b.addEventListener("click", () => press(b.dataset.k)));
      V._key = (e) => {
        if (!document.getElementById("dots")) return window.removeEventListener("keydown", V._key);
        if (/^[0-9]$/.test(e.key)) press(e.key);
        else if (e.key === "Backspace") press("del");
        else if (e.key === "Enter") press("ok");
      };
      window.removeEventListener("keydown", V._key);
      window.addEventListener("keydown", V._key);
    } else {
      const pw = app.querySelector("#pw");
      pw.focus();
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(pw.value); });
      app.querySelector("#go").addEventListener("click", () => submit(pw.value));
    }
  };

  V.showCorrupt = async () => {
    const backups = await PP.call("list_backups");
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:480px;padding:26px">
          <h2 style="margin:0 0 8px">Le fichier de données est illisible</h2>
          <p style="color:var(--muted);margin:0 0 16px">Il a peut-être été abîmé ou modifié. Tu peux restaurer une sauvegarde automatique :
            la plus récente est en haut.</p>
          ${backups.length
            ? backups.map((b) => `<div class="prof-row"><div style="flex:1">${PP.esc(b.date)}</div>
                <button class="btn btn-ghost" data-b="${PP.esc(b.name)}">Restaurer</button></div>`).join("")
            : `<div class="warn-box">Aucune sauvegarde disponible.</div>`}
        </div>
      </div>`);
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
