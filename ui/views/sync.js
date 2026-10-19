/* Synchronisation avec le téléphone : fenêtre QR (⇅) et liste des appareils (Réglages). */
(function () {
  const V = (PP.views.sync = {});
  let timer = null;     // interrogation de l'état
  let token = 0;        // invalide les réponses d'une fenêtre déjà fermée
  let opening = false;  // un sync_start est en cours : on ignore les clics répétés
  let winOpen = false;  // la fenêtre de synchro est affichée
  let stopping = Promise.resolve(); // dernier sync_stop envoyé

  const mmss = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  function stopPolling() {
    token++;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function summaryText(device, s) {
    const parts = [plural(s.to_pc, "reçu", "reçus"), plural(s.to_phone, "envoyé", "envoyés")];
    if (s.deleted) parts.push(plural(s.deleted, "supprimé", "supprimés"));
    if (s.conflicts) parts.push(s.conflicts > 1 ? `${s.conflicts} conflits : copies gardées` : "1 conflit : copie gardée");
    return `✓ Téléphone de ${device} synchronisé — ${parts.join(", ")}`;
  }

  V.open = async () => {
    if (opening) return;
    opening = true;
    try {
      // Ferme l'ancienne fenêtre (Relancer) et attend son sync_stop avant de démarrer une nouvelle session.
      if (winOpen) PP.modal.close();
      await stopping;
      let start;
      try { start = await PP.call("sync_start"); } catch (e) { return; } // l'erreur est déjà affichée
      show(start);
    } finally { opening = false; }
  };

  function show(start) {
    stopPolling();
    const my = token;
    const m = PP.modal.open(`
      <h2>${PP.icon.sync} Synchroniser le téléphone</h2>
      <div class="sync-body">
        <div class="sync-qr" id="sy-qr">${start.qr}</div>
        <p class="sync-help">Sur le téléphone : <b>Synchro → Scanner</b></p>
        <div class="sync-count" id="sy-count"></div>
        <div class="sync-state" id="sy-state"></div>
        <div class="sync-err" id="sy-err"></div>
        <div class="hint">Si Windows le demande, autorise Passe-Partout sur les réseaux privés.</div>
      </div>
      <div class="modal-foot"><button class="btn btn-primary" id="sy-retry" style="display:none">Relancer</button>
        <button class="btn btn-ghost" id="sy-close">Fermer</button></div>`,
      { cls: "sm", onClose: () => {
        stopPolling();
        winOpen = false;
        try { stopping = Promise.resolve(PP.api.sync_stop()).catch(() => {}); } catch (e) {}
      } });
    winOpen = true;

    const $ = (s) => m.querySelector(s);
    $("#sy-close").addEventListener("click", () => PP.modal.close());
    $("#sy-retry").addEventListener("click", () => V.open());

    const set = (cls, text) => { const el = $("#sy-state"); el.className = "sync-state " + cls; el.textContent = text; };
    let refreshed = false;

    const tick = async () => {
      timer = null;
      let st = null;
      try { st = await PP.api.sync_status(); } catch (e) {
        if (my !== token) return;
        if (/verrouill/i.test((e && e.message) || "")) { PP.onLocked(); return; }
      }
      if (my !== token) return;
      if (!st) { timer = setTimeout(tick, 500); return; }
      const count = $("#sy-count");
      $("#sy-err").textContent = st.state === "syncing" || st.state === "waiting" ? st.error || "" : "";
      if (st.state === "waiting" || st.state === "syncing") {
        count.textContent = mmss(st.seconds_left || 0);
        if (st.state === "waiting") set("", "En attente du téléphone…");
        else set("busy", `Synchronisation avec ${st.device || "le téléphone"}…`);
        timer = setTimeout(tick, 500);
        return;
      }
      count.textContent = "";
      $("#sy-qr").classList.add("off");
      if (st.state === "done") {
        set("ok", summaryText(st.device || "", st.summary || { to_pc: 0, to_phone: 0 }));
        if (!refreshed) { refreshed = true; try { await PP.views.main.afterChange(false); } catch (e) {} }
      } else { // expired / closed
        set("bad", st.state === "expired" ? "QR expiré" : "Synchronisation arrêtée");
        $("#sy-retry").style.display = "";
      }
    };
    set("", "En attente du téléphone…");
    $("#sy-count").textContent = mmss(start.seconds || 120);
    timer = setTimeout(tick, 500);
  }

  /* ---------- carte « Téléphones » des Réglages ---------- */
  const when = (iso) => {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso || "");
    return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : "";
  };

  V.card = (devices) => `
        <div class="card glass">
          <h3>📱 Téléphones</h3>
          <p>Les téléphones synchronisés avec ce PC. Un téléphone oublié devra scanner un nouveau QR code pour se synchroniser.</p>
          ${devices.length ? devices.map((d) => `<div class="prof-row"><div style="flex:1"><div style="font-weight:600">${PP.esc(d.name)}</div>
            <div class="hint">dernière synchro le ${PP.esc(when(d.last_sync))}</div></div>
            <button class="btn btn-ghost" data-fd="${PP.esc(d.id)}" style="padding:6px 12px">Oublier</button></div>`).join("")
            : `<div class="hint">Aucun téléphone synchronisé</div>`}
        </div>`;

  V.bindCard = (container, devices, rerender) => {
    container.querySelectorAll("[data-fd]").forEach((b) => b.addEventListener("click", async () => {
      const d = devices.find((x) => x.id === b.dataset.fd);
      if (!d) return;
      if (!(await PP.confirm(`Oublier « ${d.name} » ?`, "Ce téléphone devra scanner un nouveau QR code pour se synchroniser à nouveau.", { ok: "Oublier", danger: true }))) return;
      await PP.call("forget_device", d.id);
      PP.toast("Téléphone oublié");
      rerender();
    }));
  };
})();
