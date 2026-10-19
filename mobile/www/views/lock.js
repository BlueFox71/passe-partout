/* Téléphone — écran de verrouillage : pavé PIN ou champ mot de passe, empreinte, délai après erreurs. */
(function () {
  const V = (PP.views.lock = {});
  const FP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6.5 4.8A9 9 0 0 1 21 12v1"/><path d="M3 12a9 9 0 0 1 1.6-5.1"/><path d="M3.5 16.5c.4-1.4.5-2.9.5-4.5a8 8 0 0 1 .3-2"/>
    <path d="M8 12a4 4 0 0 1 8 0c0 2.6-.4 5.2-1.2 7.6"/><path d="M12 12c0 3.2-.6 6.2-1.8 9"/><path d="M7.4 20c.7-1.6 1.1-3.4 1.1-5.3"/>
    <path d="M20.6 16.5c-.2 1.3-.5 2.5-.9 3.7"/></svg>`;
  const MIN_CHECK_MS = 700; // l'animation de vérification reste visible au moins ce temps

  let waitTimer = null;
  let forced = null; // « pin » ou « password » choisi par la bascule, sinon le mode enregistré
  let bioTried = false; // empreinte déjà proposée automatiquement pour cet écran
  let renderSeq = 0; // jeton d'affichage : une vérification lancée par un écran remplacé est ignorée

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
    const token = ++renderSeq;
    const live = () => token === renderSeq;
    PP.pinPad.release();
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
          ${PP.pinPad.markup({
            pin: isPin, button: "Déverrouiller",
            placeholder: mode === "password" ? "Mot de passe" : "Code PIN ou mot de passe",
          })}
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

    const switchBtn = app.querySelector("#switch");
    const setBusy = (v) => { busy = v; switchBtn.disabled = v; };
    switchBtn.addEventListener("click", () => {
      if (busy) return; // pas de nouvel écran pendant une vérification
      forced = isPin ? "password" : "pin";
      render();
    });

    // `tested` : faux quand le code n'a pas été essayé (délai anti-essais encore en cours) :
    // seul « Réessaie dans N s » s'affiche alors.
    const startWait = (secs, tested = true) => {
      clearInterval(waitTimer);
      let left = Math.max(0, Math.ceil(Number(secs) || 0));
      const head = tested ? "Code incorrect" : "";
      let timer = null;
      const tick = () => {
        if (!live()) { clearInterval(timer); return; } // écran remplacé : ne touche pas au nouveau
        if (left <= 0) {
          clearInterval(timer);
          waiting = false;
          card.classList.remove("waiting");
          err.textContent = head;
          return;
        }
        waiting = true;
        card.classList.add("waiting");
        const wait = `<span class="m-wait">Réessaie dans ${left} s</span>`;
        err.innerHTML = head ? `${head}<br>${wait}` : wait;
        left--;
      };
      tick();
      timer = waitTimer = setInterval(tick, 1000);
    };

    const failed = (r) => {
      input.clear();
      card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
      // error « wait » : délai en cours, code non essayé ; « bad_code » : code essayé et faux
      startWait(r.wait_seconds, r.error !== "wait");
    };

    const opened = async () => {
      PP.state.locked = false;
      PP.pinPad.release();
      clearInterval(waitTimer);
      card.classList.add("unlocked"); // coche verte, puis ouverture du coffre
      await sleep(380);
      return PP.route();
    };

    const submit = async (value) => {
      if (!value || busy || waiting) return;
      setBusy(true);
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
      if (!live()) return; // écran remplacé entre-temps (verrouillage, nouvel affichage)
      setBusy(false);
      card.classList.remove("checking");
      if (!r) { input.clear({ field: false }); return; }
      if (r.ok) return opened();
      if (r.error === "corrupt") return PP.route();
      failed(r);
    };

    const input = PP.pinPad.bind(app, { pinLength, onSubmit: submit, blocked: () => busy || waiting });
    if (!isPin && !bio) app.querySelector("#pw").focus();

    // Empreinte : bouton, et proposée automatiquement une fois à l'affichage.
    const fp = app.querySelector("#fp");
    const tryBio = async () => {
      if (busy) return;
      setBusy(true);
      let r;
      try {
        r = await PP.call("unlock_biometric");
      } catch (e) {
        r = null;
      }
      if (!live()) return;
      setBusy(false);
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
