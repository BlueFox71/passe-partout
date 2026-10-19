/* Téléphone — onglet Réglages : empreinte digitale (l'activer redemande le code), verrouillage automatique,
   dernière synchro, nom de l'appareil, « Verrouiller maintenant », version.
   Contrat (coquille) : PP.views.settings.show(conteneur), clear().
   Le code saisi n'est jamais journalisé et sort de la page dès qu'il est vérifié. */
(function () {
  const V = (PP.views.settings = {});
  const PPM = window.PPM;
  PPM.VERSION = "0.1.0";
  const DELAYS = [1, 2, 5, 10, 15];
  const MIN_CHECK_MS = 500;

  let root = null;
  let seq = 0; // jeton d'affichage : une réponse arrivée après un nouvel affichage ou un verrouillage est ignorée
  let waitTimer = null;

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const esc = (s) => PP.esc(String(s ?? ""));

  // « 2026-10-19T18:04:00 » → « 19/10/2026 à 18:04 »
  function when(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : "";
  }

  function stop() {
    seq++;
    clearInterval(waitTimer);
    PP.pinPad.release();
  }

  V.clear = () => {
    stop();
    root = null;
  };

  V.show = async (container) => {
    stop();
    const token = seq;
    const live = () => token === seq && !!root && root.isConnected;
    const st = PP.state;
    const settings = { autolock_minutes: 5, biometric: false, ...(st.settings || {}) };
    let info = {};
    let bioAvail = false;
    try {
      info = await PP.api.sync_info();
    } catch (e) { /* meta illisible : « Jamais synchronisé » */ }
    try {
      bioAvail = !!(await PP.mobile.native.biometricAvailable());
    } catch (e) { /* indisponible */ }
    if (token !== seq || !container.isConnected) return;

    const sync = info.last_sync && when(info.last_sync)
      ? `Synchronisé avec ${esc(info.pc_name || "le PC")} le ${esc(when(info.last_sync))}`
      : "Jamais synchronisé";
    const cur = Number(settings.autolock_minutes);
    const delays = DELAYS.includes(cur) ? DELAYS : [...DELAYS, cur].sort((a, b) => a - b);
    container.innerHTML = `
      <div class="m-set">
        <div class="m-head"><h1>Réglages</h1></div>
        <div class="m-set-body">
          <div class="m-card glass m-set-card">
            ${bioAvail ? `<div class="m-set-row">
              <div class="m-set-t"><b>Empreinte digitale</b><small>Ouvrir Passe-Partout avec ton doigt</small></div>
              <button type="button" class="toggle${settings.biometric ? " on" : ""}" id="s-bio" role="switch"
                aria-checked="${!!settings.biometric}" aria-label="Empreinte digitale"><i></i></button>
            </div>
            <div id="s-code" hidden></div>` : ""}
            <div class="m-set-row">
              <label class="m-set-t" for="s-lock"><b>Verrouillage automatique</b><small>Après une période sans activité</small></label>
              <select class="input m-set-sel" id="s-lock">
                ${delays.map((m) => `<option value="${m}"${m === cur ? " selected" : ""}>${m} min</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="m-card glass m-set-card">
            <div class="m-set-t"><b>Synchronisation</b><small id="s-sync">${sync}</small></div>
            <div class="m-set-t"><b>Cet appareil</b><small>${esc(info.device_name || "Téléphone")}</small></div>
          </div>
          <button type="button" class="btn btn-primary m-wide" id="s-now">Verrouiller maintenant</button>
          <div class="hint m-center">Passe-Partout ${esc(PPM.VERSION)}</div>
        </div>
      </div>`;
    root = container.firstElementChild;

    root.querySelector("#s-now").addEventListener("click", () => { PP.lockNow().catch(() => {}); });

    root.querySelector("#s-lock").addEventListener("change", async (e) => {
      const sel = e.target;
      try {
        const r = await PP.call("save_settings", { autolock_minutes: Number(sel.value) });
        PP.state.settings = { ...(PP.state.settings || {}), autolock_minutes: r.autolock_minutes, biometric: r.biometric };
        PP.toast(`Verrouillage automatique : ${r.autolock_minutes} min`);
      } catch (err) {
        if (live()) sel.value = String(PP.state.settings.autolock_minutes);
      }
    });

    const bio = root.querySelector("#s-bio");
    if (!bio) return;
    const codeBox = root.querySelector("#s-code");
    const setBio = (on) => {
      bio.classList.toggle("on", on);
      bio.setAttribute("aria-checked", String(on));
    };
    const closeCode = () => {
      clearInterval(waitTimer);
      PP.pinPad.release();
      codeBox.hidden = true;
      codeBox.innerHTML = ""; // le code saisi ne reste pas dans la page
    };
    const saveBio = async (on) => {
      bio.disabled = true;
      try {
        const r = await PP.call("save_settings", { biometric: on });
        PP.state.settings = { ...(PP.state.settings || {}), autolock_minutes: r.autolock_minutes, biometric: r.biometric };
        PP.state.biometric = r.biometric;
        if (live()) setBio(r.biometric);
        if (on) PP.toast(r.biometric ? "Empreinte activée" : "L'empreinte n'a pas été activée", { error: !r.biometric });
      } catch (e) {
        if (live()) setBio(!!(PP.state.settings || {}).biometric); // erreur déjà signalée par PP.call
      } finally {
        if (live()) bio.disabled = false;
      }
    };

    // Redemande du code (pavé ou mot de passe, comme l'écran de verrouillage), puis activation.
    const askCode = () => {
      const isPin = st.lock_mode === "pin" && Number(st.pin_length) > 0;
      const pinLength = isPin ? Number(st.pin_length) : 0;
      codeBox.hidden = false;
      codeBox.innerHTML = `
        <div class="m-set-code">
          <div class="m-prompt">${isPin ? "Entre ton code PIN" : "Entre ton mot de passe"} pour activer l'empreinte</div>
          ${PP.pinPad.markup({ pin: isPin, button: "Valider", placeholder: "Mot de passe" })}
          <div class="err m-err" id="s-err"></div>
          <button type="button" class="m-link" id="s-cancel">Annuler</button>
        </div>`;
      const err = codeBox.querySelector("#s-err");
      let busy = false;
      let waiting = false;
      codeBox.querySelector("#s-cancel").addEventListener("click", () => { closeCode(); setBio(false); });

      const startWait = (secs, tested) => {
        clearInterval(waitTimer);
        let left = Math.max(0, Math.ceil(Number(secs) || 0));
        const head = tested ? "Code incorrect" : "";
        const tick = () => {
          if (!live() || !err.isConnected) { clearInterval(waitTimer); return; }
          if (left <= 0) {
            clearInterval(waitTimer);
            waiting = false;
            err.textContent = head;
            return;
          }
          waiting = true;
          const w = `<span class="m-wait">Réessaie dans ${left} s</span>`;
          err.innerHTML = head ? `${head}<br>${w}` : w;
          left--;
        };
        tick();
        waitTimer = setInterval(tick, 1000);
      };

      const submit = async (value) => {
        if (!value || busy || waiting) return;
        busy = true;
        err.textContent = "Vérification…";
        const t0 = Date.now();
        let r;
        try {
          r = await PP.call("verify_code", value);
        } catch (e) {
          r = null;
        }
        const left = MIN_CHECK_MS - (Date.now() - t0);
        if (left > 0) await sleep(left);
        if (!live() || !err.isConnected) return;
        busy = false;
        if (!r) { err.textContent = ""; input.clear({ field: false }); return; }
        input.clear();
        if (r.ok) {
          closeCode();
          return saveBio(true);
        }
        if (r.error === "corrupt") return PP.route();
        startWait(r.wait_seconds, r.error !== "wait");
      };
      const input = PP.pinPad.bind(codeBox, { pinLength, onSubmit: submit, blocked: () => busy || waiting });
      if (!isPin) codeBox.querySelector("#pw").focus();
    };

    bio.addEventListener("click", () => {
      if (bio.disabled) return;
      if (bio.classList.contains("on")) {
        closeCode();
        saveBio(false);
      } else if (codeBox.hidden) {
        setBio(true);
        askCode();
      }
    });
  };
})();
