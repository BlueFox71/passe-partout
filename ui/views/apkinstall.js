/* Installer l'appli Android depuis le PC : fenêtre QR (téléchargement de l'APK sur le réseau local). */
(function () {
  const V = (PP.views.apkinstall = {});
  let timer = null;     // interrogation de l'état
  let token = 0;        // invalide les réponses d'une fenêtre déjà fermée
  let opening = false;  // un apk_install_start est en cours : on ignore les clics répétés
  let winOpen = false;  // la fenêtre est affichée
  let stopping = Promise.resolve(); // dernier apk_install_stop envoyé

  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

  function stopPolling() {
    token++;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  V.open = async () => {
    if (opening) return;
    opening = true;
    try {
      // Ferme l'ancienne fenêtre (Relancer) et attend son arrêt avant de démarrer une nouvelle session.
      if (winOpen) PP.modal.close();
      await stopping;
      let start;
      try { start = await PP.call("apk_install_start"); } catch (e) { return; } // l'erreur est déjà affichée
      show(start);
    } finally { opening = false; }
  };

  function show(start) {
    stopPolling();
    const my = token;
    const m = PP.modal.open(`
      <h2>${PP.icon.phone.replace("<svg", '<svg style="width:22px"')} Installer l'appli sur le téléphone</h2>
      <div class="sync-body">
        <div class="sync-qr" id="ap-qr">${start.qr}</div>
        <ol class="apk-steps">
          <li><span>1</span>Ouvre l'appareil photo du téléphone</li>
          <li><span>2</span>Vise ce QR code et ouvre le lien</li>
          <li><span>3</span>Installe le fichier téléchargé — Android demandera d'autoriser l'installation</li>
        </ol>
        <div class="apk-urls" id="ap-urls"></div>
        <div class="sync-count" id="ap-count"></div>
        <div class="sync-state" id="ap-state"></div>
        <div class="hint">Le téléphone doit être sur le même réseau Wi-Fi que le PC. Si Windows le demande, autorise Passe-Partout sur les réseaux privés.</div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" id="ap-retry" style="display:none">Relancer</button>
        <button class="btn btn-ghost" id="ap-close">Fermer</button></div>`,
      { cls: "sm", onClose: () => {
        stopPolling();
        winOpen = false;
        try { stopping = Promise.resolve(PP.api.apk_install_stop()).catch(() => {}); } catch (e) {}
      } });
    winOpen = true;

    const $ = (s) => m.querySelector(s);
    $("#ap-close").addEventListener("click", () => PP.modal.close());
    $("#ap-retry").addEventListener("click", () => V.open());

    // Plusieurs cartes réseau : même serveur, seule l'adresse change.
    const urls = Array.isArray(start.urls) && start.urls.length ? start.urls : [start.url];
    let current = start.url || urls[0];
    const drawUrls = () => {
      const box = $("#ap-urls");
      box.textContent = "";
      if (urls.length < 2) return;
      urls.forEach((u) => {
        if (u === current) return;
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = `Autre adresse : ${u.replace(/^https?:\/\//, "").split("/")[0]}`;
        a.addEventListener("click", async (ev) => {
          ev.preventDefault();
          let svg;
          try { svg = await PP.call("apk_qr", u); } catch (e) { return; }
          if (my !== token || !winOpen) return;
          $("#ap-qr").innerHTML = svg;
          current = u;
          drawUrls();
        });
        box.appendChild(a);
      });
    };
    drawUrls();

    const set = (cls, text) => { const el = $("#ap-state"); el.className = "sync-state " + cls; el.textContent = text; };
    let done = false;
    const tick = async () => {
      timer = null;
      let st = null;
      try { st = await PP.api.apk_install_status(); } catch (e) { /* on réessaie */ }
      if (my !== token) return;
      if (!st) { timer = setTimeout(tick, 1000); return; }
      if (st.downloads > 0) { done = true; set("ok", "✓ Appli téléchargée par le téléphone"); }
      if (st.state === "waiting" || st.state === "done") {
        $("#ap-count").textContent = st.state === "waiting" ? mmss(st.seconds_left || 0) : "";
        timer = setTimeout(tick, 1000);
        return;
      }
      $("#ap-count").textContent = "";
      $("#ap-qr").classList.add("off");
      $("#ap-urls").textContent = "";
      if (!done) set("bad", st.state === "expired" ? "QR expiré" : "Installation arrêtée");
      $("#ap-retry").style.display = "";
    };
    set("", "En attente du téléphone…");
    $("#ap-count").textContent = mmss(start.seconds || 300);
    timer = setTimeout(tick, 1000);
  }
})();
