/* Téléphone — écran de verrouillage : pavé PIN ou champ mot de passe, empreinte, délai après erreurs. */
(function () {
  const V = (PP.views.lock = {});
  const FP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6.5 4.8A9 9 0 0 1 21 12v1"/><path d="M3 12a9 9 0 0 1 1.6-5.1"/><path d="M3.5 16.5c.4-1.4.5-2.9.5-4.5a8 8 0 0 1 .3-2"/>
    <path d="M8 12a4 4 0 0 1 8 0c0 2.6-.4 5.2-1.2 7.6"/><path d="M12 12c0 3.2-.6 6.2-1.8 9"/><path d="M7.4 20c.7-1.6 1.1-3.4 1.1-5.3"/>
    <path d="M20.6 16.5c-.2 1.3-.5 2.5-.9 3.7"/></svg>`;
  const MIN_CHECK_MS = 700; // l'animation de vérification reste visible au moins ce temps

  let code = "";
  let waitTimer = null;
  let press = null; // pavé PIN affiché actuellement (null sinon)
  let forced = null; // « pin » ou « password » choisi par la bascule, sinon le mode enregistré
  let bioTried = false; // empreinte déjà proposée automatiquement pour cet écran

  // Un seul écouteur clavier (aperçu sur ordinateur) : réafficher l'écran ne doit pas doubler les touches.
  window.addEventListener("keydown", (e) => {
    if (!press || !document.getElementById("dots")) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === "Backspace") press("del");
    else if (e.key === "Enter") { e.preventDefault(); press("ok"); }
  });

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Mode affiché : « pin » (pavé), « password » ou « unknown » (champ libre).
  function modeOf(s) {
    if (forced) return forced;
    if (s.lock_mode === "pin" && Number(s.pin_length) > 0) return "pin";
    if (s.lock_mode === "password") return "password";
    return "unknown";
  }

  // Appelé par PP.onLocked (ui/app.js) et par PP.route.
  V.show = async () => {
    // état à jour (empreinte activée entre-temps, mode du verrou) ; get_state reste permis verrouillé
    try {
      await PP.refreshState();
    } catch (e) { /* erreur déjà signalée : on garde l'état connu */ }
    const s = PP.state;
    if (s.corrupt) return PP.views.welcome.showCorrupt();
    if (!s.locked) return PP.route(); // rien à déverrouiller (pas de données)
    bioTried = false;
    forced = null;
    return render();
  };

  function render() {
    code = "";
    press = null;
    clearInterval(waitTimer);
    const s = PP.state;
    const mode = modeOf(s);
    const isPin = mode === "pin";
    const pinLength = isPin && !forced ? Number(s.pin_length) || 0 : 0;
    const bio = !!s.biometric;
    const prompt = isPin ? "Entre ton code PIN" : mode === "password" ? "Entre ton mot de passe" : "Entre ton code PIN ou ton mot de passe";
    const app = PP.render(`
      <div class="m-screen m-lock">
        ${PP.brand("big-brand")}
        <div class="lock-card m-lock-card">
          <div class="lock-ok">${PP.icon.check}</div>
          <div class="m-prompt">${prompt}</div>
          ${isPin
            ? `<div class="pin-dots" id="dots"></div>
               <div class="pin-pad m-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-k="${n}">${n}</button>`).join("")}
                 <button type="button" data-k="del" aria-label="Effacer">⌫</button><button type="button" data-k="0">0</button>
                 <button type="button" data-k="ok" aria-label="Valider" class="m-ok">✓</button></div>`
            : `<input id="pw" class="input m-pw" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="${mode === "password" ? "Mot de passe" : "Code PIN ou mot de passe"}">
               <button type="button" class="btn btn-primary m-wide" id="go">Déverrouiller</button>`}
          <div class="m-check" id="check">Vérification…</div>
          <div class="err m-err" id="err"></div>
          ${isPin && !pinLength ? `<div class="hint m-center">Valide avec ✓ : ensuite, le code se validera tout seul.</div>` : ""}
        </div>
        ${bio ? `<button type="button" class="m-fp" id="fp" aria-label="Déverrouiller avec l'empreinte">${FP}</button>
                 <div class="hint m-center">ou ton empreinte</div>` : ""}
        <button type="button" class="m-link" id="switch">${isPin ? "Saisir un mot de passe" : "Saisir un PIN"}</button>
      </div>`);

    const card = app.querySelector(".lock-card");
    const err = app.querySelector("#err");
    let busy = false;
    let waiting = false;

    app.querySelector("#switch").addEventListener("click", () => {
      forced = isPin ? "password" : "pin";
      render();
    });

    const startWait = (secs) => {
      clearInterval(waitTimer);
      let left = Math.max(0, Math.ceil(Number(secs) || 0));
      const tick = () => {
        if (left <= 0) {
          clearInterval(waitTimer);
          waiting = false;
          card.classList.remove("waiting");
          err.textContent = "Code incorrect";
          return;
        }
        waiting = true;
        card.classList.add("waiting");
        err.innerHTML = `Code incorrect<br><span class="m-wait">Réessaie dans ${left} s</span>`;
        left--;
      };
      tick();
      waitTimer = setInterval(tick, 1000);
    };

    const failed = (r) => {
      code = "";
      drawDots();
      card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
      startWait(r.wait_seconds);
      const pw = app.querySelector("#pw");
      if (pw) { pw.value = ""; pw.focus(); }
    };

    const opened = async () => {
      PP.state.locked = false;
      press = null;
      clearInterval(waitTimer);
      card.classList.add("unlocked"); // coche verte, puis ouverture du coffre
      await sleep(380);
      return PP.route();
    };

    const submit = async (value) => {
      if (!value || busy || waiting) return;
      busy = true;
      card.classList.add("checking"); // points animés pendant la vérification (PBKDF2)
      err.textContent = "";
      const t0 = Date.now();
      let r;
      try {
        r = await PP.call("unlock", value);
      } catch (e) {
        r = null; // erreur déjà affichée par PP.call
      }
      const left = MIN_CHECK_MS - (Date.now() - t0);
      if (left > 0) await sleep(left);
      busy = false;
      card.classList.remove("checking");
      if (!r) { code = ""; drawDots(); return; }
      if (r.ok) return opened();
      if (r.error === "corrupt") return PP.route();
      failed(r);
    };

    const drawDots = () => {
      const d = app.querySelector("#dots");
      if (!d) return;
      // longueur inconnue : seulement les chiffres tapés (pas de cases vides qui suggéreraient une longueur)
      const n = pinLength || code.length;
      d.innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < code.length ? "f" : ""}"></i>`).join("");
    };

    if (isPin) {
      drawDots();
      press = (k) => {
        if (busy || waiting) return;
        if (k === "del") code = code.slice(0, -1);
        else if (k === "ok") return submit(code);
        else if (code.length < (pinLength || 12)) code += k;
        drawDots();
        if (pinLength && code.length === pinLength) submit(code);
      };
      app.querySelectorAll("[data-k]").forEach((b) => {
        b.tabIndex = -1;
        b.addEventListener("mousedown", (e) => e.preventDefault()); // pas de focus : Entrée ne « reclique » pas
        b.addEventListener("click", () => press(b.dataset.k));
      });
    } else {
      const pw = app.querySelector("#pw");
      pw.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(pw.value); });
      app.querySelector("#go").addEventListener("click", () => submit(pw.value));
      if (!bio) pw.focus();
    }

    // Empreinte : bouton, et proposée automatiquement une fois à l'affichage.
    const fp = app.querySelector("#fp");
    const tryBio = async () => {
      if (busy) return;
      busy = true;
      let r;
      try {
        r = await PP.call("unlock_biometric");
      } catch (e) {
        r = null;
      }
      busy = false;
      if (!r) return;
      if (r.ok) return opened();
      if (r.error === "corrupt") return PP.route();
      if (r.error === "bio_invalidated") {
        PP.state.biometric = false;
        PP.toast("Empreinte désactivée : les empreintes du téléphone ont changé. Saisis ton code, puis réactive-la dans Réglages.", { seconds: 6 });
        render();
      }
      // « canceled » : on reste sur l'écran, le bouton permet de réessayer
    };
    if (fp) {
      fp.addEventListener("click", tryBio);
      if (!bioTried) {
        bioTried = true;
        setTimeout(() => { if (document.body.contains(fp)) tryBio(); }, 250);
      }
    }
  }
})();
