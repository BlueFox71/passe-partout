/* Téléphone — synchronisation avec le PC : scan du QR, hello, code du PC, confirmation de remplacement,
   sync, enregistrement (apply_sync) puis résumé.
   Contrat (décision 14) : V.show(container?) — sans conteneur, plein écran (accueil, données illisibles :
   l'appli n'est pas déverrouillée et n'a pas de données) ; avec un conteneur, dans l'onglet Synchro.
   Le code saisi n'est jamais journalisé ni gardé après l'échange.
   Appairage (Ruling 21) : un téléphone appairé refuse un PC qui ne prouve pas le secret commun, avant
   d'envoyer code ou coffre (« Ré-appairer » oublie le secret local). Pendant l'envoi de la synchro, onglets
   et bouton Retour sont bloqués (Ruling 22).
   Version : un PC d'une autre version refuse le hello. Plus récent → « Mettre à jour » télécharge l'APK dans
   la même session (même client, jamais de second hello), vérifié par SHA-256, puis l'installateur d'Android. */
(function () {
  const V = (PP.views.sync = {});
  const PPM = window.PPM;
  const MIN_CHECK_MS = 500; // l'animation de vérification reste visible au moins ce temps
  const RETRY_ERRORS = ["bad_code", "code_required"]; // erreurs du PC après lesquelles seul « sync » est renvoyé

  let container = null; // conteneur de l'onglet, ou null en plein écran
  let seq = 0; // jeton d'affichage : une étape lancée par un écran remplacé s'arrête
  let pending = null; // client dont le hello a réussi mais sans sync aboutie (à annuler si on quitte)
  let waitTimer = null;
  let inFlight = false; // requête sync envoyée, réponse pas encore enregistrée
  let screen = null; // élément affiché

  const MODIFIED = "Modifié pendant la synchro : relance la synchronisation.";

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const esc = (s) => PP.esc(String(s ?? ""));
  const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

  // « 2026-10-19T18:04:00 » → « 19/10/2026 à 18:04 »
  function when(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
    return m ? `${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : "";
  }

  function abandon() {
    const c = pending;
    pending = null;
    if (c) c.cancel(); // jamais d'erreur
  }

  function stop() {
    seq++;
    PP.pinPad.release();
    clearInterval(waitTimer);
  }

  // Affiche un écran ; renvoie {el, live} où live() est faux dès qu'un autre écran l'a remplacé.
  // `before` : contenu placé au-dessus de la carte (illustration de l'écran de départ).
  function paint(inner, before = "") {
    stop();
    const token = seq;
    const html = `${before}<div class="m-card glass m-sync-card">${inner}</div>`;
    let el;
    if (container) {
      container.innerHTML = `<div class="m-sync"><div class="m-head"><h1>Synchro</h1></div>
        <div class="m-sync-body">${html}</div></div>`;
      el = container.firstElementChild;
    } else {
      el = PP.render(`<div class="m-screen m-sync">${PP.brand("big-brand")}${html}</div>`).firstElementChild;
    }
    screen = el;
    const live = () => token === seq && el.isConnected;
    return { el, live };
  }

  function setInFlight(on) {
    inFlight = on;
    if (PP.views.shell && PP.views.shell.setLocked) PP.views.shell.setLocked(on);
  }

  V.busy = () => inFlight;
  // Vue plein écran affichée (accueil, données illisibles) : le bouton Retour y revient.
  V.fullscreen = () => !container && !!screen && screen.isConnected;

  V.show = (target) => {
    abandon();
    container = target || null;
    startScreen();
  };

  // Au verrouillage (coquille) : plus rien de la synchro en cours.
  V.clear = () => {
    stop();
    abandon();
  };

  // ------------------------------------------------------------ écran de départ
  // Illustration néon : téléphone ⇄ PC reliés par deux flux de points (aller en haut, retour en bas).
  // Animations CSS seulement (mobile.css), figées si l'appareil demande moins de mouvement.
  const HERO = `<svg class="m-sync-hero" viewBox="0 0 340 170" role="img" aria-label="Téléphone et PC reliés">
    <defs>
      <linearGradient id="sy-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#ff3d9a"/><stop offset="1" stop-color="#7c3aed"/>
      </linearGradient>
      <linearGradient id="sy-link" x1="96" y1="0" x2="214" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#ff3d9a"/><stop offset=".5" stop-color="#00e5ff"/><stop offset="1" stop-color="#7c3aed"/>
      </linearGradient>
      <filter id="sy-glow" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="3.5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <g class="sy-link">
      <path class="sy-halo" d="M98 72 C135 40 175 40 212 66"/>
      <path class="sy-halo" d="M212 102 C175 128 135 128 98 98"/>
      <path class="sy-rail" d="M98 72 C135 40 175 40 212 66"/>
      <path class="sy-rail" d="M212 102 C175 128 135 128 98 98"/>
      <path class="sy-flow sy-out" d="M98 72 C135 40 175 40 212 66"/>
      <path class="sy-flow sy-in" d="M212 102 C175 128 135 128 98 98"/>
    </g>
    <g filter="url(#sy-glow)" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <!-- téléphone : cadre de visée cyan et ligne de scan rose, comme l'écran de scan -->
      <rect x="40" y="30" width="54" height="104" rx="11" stroke="url(#sy-grad)" stroke-width="3.5"/>
      <path d="M61 39h12" stroke="url(#sy-grad)" stroke-width="2.5"/>
      <path d="M54 66v-6h6M80 60h6v6M86 98v6h-6M60 104h-6v-6" stroke="#00e5ff" stroke-width="2.5"/>
      <path class="sy-scan" d="M55 82h30" stroke="#ff3d9a" stroke-width="2.5"/>
      <!-- PC portable : le QR code affiché à l'écran -->
      <rect x="216" y="38" width="96" height="66" rx="7" stroke="url(#sy-grad)" stroke-width="3.5"/>
      <path d="M202 116h124l-8 12H210z" stroke="url(#sy-grad)" stroke-width="3.5"/>
      <g stroke="#00e5ff" stroke-width="2.5">
        <rect x="245" y="50" width="12" height="12" rx="2"/><rect x="271" y="50" width="12" height="12" rx="2"/>
        <rect x="245" y="78" width="12" height="12" rx="2"/>
        <path d="M271 78h5M281 78v5M271 86v4h5M281 90h2"/>
      </g>
    </g>
  </svg>`;
  const ICON_PC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
  const ICON_QR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5"/><rect x="7" y="7" width="4" height="4" rx=".5"/><rect x="13" y="13" width="4" height="4" rx=".5"/><path d="M13 7h4v3M7 14v3h3"/></svg>';
  // Étapes : le bouton du PC porte la même icône téléphone (PP.icon.phone, lue à l'affichage).
  const steps = () => [
    [ICON_PC, "Sur le PC, ouvre <b>Passe-Partout</b>"],
    [PP.icon.phone, "Clique sur le <b>bouton téléphone</b> en haut"],
    [ICON_QR, "Scanne le <b>QR code</b> avec ce téléphone"],
  ];

  function startScreen(error = "", note = "") {
    const { el, live } = paint(`
      <h2>Synchroniser avec le PC</h2>
      <ol class="m-steps">${steps().map(([ic, txt], i) => `
        <li><span class="m-step-ic" aria-hidden="true">${ic}<b>${i + 1}</b></span><span>${txt}</span></li>`).join("")}
      </ol>
      <div class="m-wifi">📶 Le téléphone et le PC doivent être sur le même&nbsp;Wi&#8209;Fi</div>
      <div class="hint" id="last"></div>
      ${error ? `<div class="warn-box" id="err">${esc(error)}</div>` : ""}
      ${note ? `<div class="hint" id="note">${esc(note)}</div>` : ""}
      <button type="button" class="btn btn-primary m-wide" id="scan">${PP.icon.sync}Scanner le QR code du PC</button>
      ${container ? "" : `<button type="button" class="m-link" id="back">Retour</button>`}`, HERO);
    el.querySelector("#scan").addEventListener("click", () => scan());
    const back = el.querySelector("#back");
    if (back) back.addEventListener("click", () => PP.route());
    if (container) {
      PP.api.sync_info().then((i) => {
        if (live() && i.has_data && i.last_sync) el.querySelector("#last").textContent = `Dernière synchro : ${when(i.last_sync)}`;
      }).catch(() => {});
    }
  }

  function busyScreen(text) {
    return paint(`<div class="m-busy"><span class="m-spin" aria-hidden="true"></span><span>${esc(text)}</span></div>`);
  }

  // ------------------------------------------------------------ scan puis hello
  async function scan() {
    const native = PP.mobile.native;
    const token = seq;
    let text;
    try {
      text = await native.scanQr();
    } catch (e) {
      // appareil photo refusé : le natif explique où l'autoriser
      if (token === seq) startScreen(e && e.code === "CAMERA_DENIED" && e.message ? e.message : "Impossible d'ouvrir l'appareil photo.");
      return;
    }
    if (token !== seq) return;
    if (text == null || text === "") return; // scan annulé : on reste sur l'écran
    let qr;
    try {
      qr = PPM.parseQr(text);
    } catch (e) {
      return startScreen(e.message);
    }
    const { live } = busyScreen(`Connexion à ${qr.pc}…`);
    const client = new PPM.SyncClient({ qr, post: (u, b, t) => native.post(u, b, t) });
    let info;
    let hello;
    try {
      info = await PP.api.sync_info();
      const pair = await PP.api.sync_pair(); // jamais envoyé : seule sa preuve part dans le hello
      hello = await client.hello(info, { pair });
    } catch (e) {
      if (e && e.code === "update_required" && e.details) {
        pending = client; // session gardée ouverte : « Mettre à jour » y demande l'APK
        if (!live()) return abandon();
        return updateScreen(client, e.details);
      }
      if (e && e.code === "pc_outdated") {
        pending = client;
        abandon(); // session terminée : le PC ne synchronisera pas ce téléphone
        if (live()) startScreen(e.message);
        return;
      }
      if (e && e.code === "unpaired") {
        pending = client; // si c'est bien le PC, sa session est annulée en quittant cet écran
        if (!live()) return abandon();
        return unpairedScreen(e.message);
      }
      if (live()) startScreen(e.code ? e.message : "Synchronisation impossible.");
      return;
    }
    if (!hello.ok) {
      // clock, locked, no_lock, invalid… : un seul hello par QR, il faut en scanner un nouveau
      if (live()) startScreen(hello.message || "Le PC a refusé la synchronisation.");
      return;
    }
    pending = client;
    if (!live()) return abandon();
    const ctx = { client, info, hello };

    if (hello.mode === "replace" && (hello.reason === "restored" || hello.reason === "stale")) {
      const since = when(hello.since);
      const text2 = hello.reason === "restored"
        ? `Le PC a restauré une sauvegarde : tes modifications faites sur le téléphone depuis le ${since || "dernier échange"} seront remplacées.`
        : "Ce téléphone n'a pas été synchronisé depuis plus de 180 jours : ses données seront remplacées par celles du PC.";
      const ok = await PP.confirm("Remplacer les données du téléphone ?", text2, { ok: "Remplacer", danger: true });
      if (!live()) return abandon();
      if (!ok) {
        abandon();
        return startScreen();
      }
    }
    if (hello.need_code) return codeScreen(ctx);
    return runSync(ctx, null, busyScreen("Synchronisation…").live);
  }

  // ------------------------------------------------------------ sync et enregistrement
  // `cur` : vrai tant que l'écran appelant est affiché. Renvoie l'erreur du PC à montrer sur l'écran du
  // code (code faux ou manquant : seul « sync » sera renvoyé), sinon null (résumé ou autre écran affiché).
  async function runSync(ctx, code, cur) {
    setInFlight(true);
    try {
      return await sendAndApply(ctx, code, cur);
    } finally {
      setInFlight(false);
    }
  }

  async function sendAndApply(ctx, code, cur) {
    const { client, info, hello } = ctx;
    let reply;
    try {
      // toujours demandé : il note la révision du coffre, que apply_sync compare (Ruling 22)
      const payload = await PP.api.sync_payload();
      const vault = hello.mode === "merge" ? payload : null;
      const now = (await PP.api.sync_info()).now; // heure fraîche : la saisie du code a pu durer
      reply = await client.sync(PPM.syncMessage(info, hello, { vault, code, now }));
    } catch (e) {
      pending = null; // QR expiré, refusé ou PC injoignable : il faudra un nouveau QR
      if (cur()) startScreen(e.code ? e.message : (e && e.message) || "Synchronisation impossible.");
      return null;
    }
    if (!reply.ok) {
      if (ctx.onCodeScreen && RETRY_ERRORS.includes(reply.error)) return cur() ? reply : (abandon(), null);
      abandon();
      if (cur()) startScreen(reply.message || "Le PC a refusé la synchronisation.");
      return null;
    }
    pending = null; // session terminée côté PC
    let applied;
    try {
      applied = await PP.call("apply_sync", { ...reply, pc: hello.pc }, code);
    } catch (e) {
      if (cur()) startScreen("Les données reçues n'ont pas pu être enregistrées sur le téléphone : relance la synchronisation.");
      return null;
    }
    if (applied && applied.error === "modified") {
      // coffre modifié pendant l'échange : rien n'a été remplacé, la modification partira au prochain essai
      if (cur()) startScreen(MODIFIED);
      return null;
    }
    try {
      await PP.refreshState();
    } catch (e) { /* état relu plus tard par PP.route */ }
    if (cur()) summaryScreen(hello.pc, reply.summary || {});
    return null;
  }

  // ------------------------------------------------------------ mise à jour de l'appli
  // `d` : détails du refus (SyncClient) ; sans empreinte, le PC n'a pas d'APK : son message seul.
  function updateScreen(client, d) {
    if (!d.sha256) {
      abandon();
      return startScreen(d.message);
    }
    const from = d.current || PPM.VERSION || "?";
    const { el, live } = paint(`
      <h2>Mise à jour</h2>
      <div class="warn-box">Une nouvelle version est disponible (${esc(from)} → ${esc(d.available)}) : mets-la à jour pour synchroniser.</div>
      <div class="m-busy m-update-busy" id="busy" hidden><span class="m-spin" aria-hidden="true"></span><span>Téléchargement…</span></div>
      <div class="err m-err" id="err"></div>
      <div class="hint m-update-note" id="note"></div>
      <button type="button" class="btn btn-primary m-wide" id="update">Mettre à jour</button>
      <button type="button" class="m-link" id="cancel">Annuler</button>`);
    const btn = el.querySelector("#update");
    const busy = el.querySelector("#busy");
    const err = el.querySelector("#err");
    const note = el.querySelector("#note");
    let apk = null; // octets vérifiés, gardés pour relancer l'installateur sans retélécharger

    el.querySelector("#cancel").addEventListener("click", () => {
      abandon();
      startScreen();
    });

    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      err.textContent = "";
      note.textContent = "";
      if (!apk) {
        busy.hidden = false;
        try {
          apk = await client.downloadApk();
        } catch (e) {
          if (!live()) return;
          busy.hidden = true;
          btn.disabled = false;
          if (e && (e.code === "expired" || e.code === "forbidden")) {
            pending = null; // session finie côté PC : il faut un nouveau QR
            return startScreen(e.message);
          }
          err.textContent = e && e.code ? e.message : "Téléchargement impossible : réessaie.";
          return;
        }
        if (!live()) return;
        busy.hidden = true;
      }
      try {
        await PP.mobile.native.installApk(apk);
      } catch (e) {
        if (!live()) return;
        btn.disabled = false;
        err.textContent = e && e.code === "INSTALL_PERMISSION"
          ? "Autorise Passe-Partout à installer des applis, puis appuie à nouveau sur « Mettre à jour »."
          : "L'installation n'a pas pu démarrer : réessaie.";
        return;
      }
      if (!live()) return;
      btn.disabled = false;
      note.textContent = "Installe la mise à jour, puis rouvre Passe-Partout et relance la synchronisation.";
    });
  }

  // ------------------------------------------------------------ PC non reconnu (Ruling 21)
  function unpairedScreen(message) {
    const { el, live } = paint(`
      <h2>PC non reconnu</h2>
      <div class="warn-box">${esc(message)}</div>
      <button type="button" class="btn btn-primary m-wide" id="repair">Ré-appairer</button>
      <button type="button" class="m-link" id="cancel">Annuler</button>`);
    el.querySelector("#cancel").addEventListener("click", () => {
      abandon();
      startScreen();
    });
    const repair = el.querySelector("#repair");
    repair.addEventListener("click", async () => {
      repair.disabled = true;
      abandon(); // la session de ce QR a déjà servi : il en faut un nouveau
      try {
        await PP.call("forget_pair");
      } catch (e) {
        if (live()) repair.disabled = false;
        return;
      }
      if (live()) {
        startScreen("", "Appairage effacé. Relance « Synchroniser le téléphone » sur le PC puis scanne le nouveau "
          + "QR code : le code du PC te sera demandé.");
      }
    });
  }

  // ------------------------------------------------------------ code du PC
  function codeScreen(ctx) {
    const { hello, info } = ctx;
    ctx.onCodeScreen = true;
    // comme l'écran de verrouillage : pavé seulement si la longueur du PIN est connue, sinon champ libre
    const pinLength = hello.lock_mode === "pin" ? Number(hello.pin_length) || 0 : 0;
    const isPin = pinLength > 0;
    const prompt = info.has_data ? "Le code du PC a changé : saisis le nouveau code" : "Saisis le code du PC";
    const { el, live } = paint(`
      <div class="lock-card m-lock-card m-sync-code">
        <h2>${esc(hello.pc)}</h2>
        <div class="m-prompt">${prompt}</div>
        ${PP.pinPad.markup({
          pin: isPin, button: "Valider",
          placeholder: hello.lock_mode === "password" ? "Mot de passe du PC" : "Code PIN ou mot de passe du PC",
        })}
        <div class="m-check">Vérification…</div>
        <div class="err m-err" id="err"></div>
      </div>
      <button type="button" class="m-link" id="cancel">Annuler</button>`);
    const card = el.querySelector(".lock-card");
    const err = el.querySelector("#err");
    const cancelBtn = el.querySelector("#cancel");
    let busy = false;
    let waiting = false;

    cancelBtn.addEventListener("click", () => {
      if (busy) return;
      abandon();
      startScreen();
    });

    // Erreur du PC : message tel quel, puis « Réessaie dans N s » tant que le délai court.
    const showError = (reply) => {
      input.clear({ field: false });
      const pw = el.querySelector("#pw");
      if (pw) pw.value = "";
      card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
      const head = esc(reply.message || "Code incorrect.");
      let left = Math.max(0, Math.ceil(Number(reply.wait_seconds) || 0));
      clearInterval(waitTimer);
      const tick = () => {
        if (!live()) { clearInterval(waitTimer); return; }
        if (left <= 0) {
          clearInterval(waitTimer);
          waiting = false;
          card.classList.remove("waiting");
          err.innerHTML = head;
          if (pw) pw.focus();
          return;
        }
        waiting = true;
        card.classList.add("waiting");
        err.innerHTML = `${head}<br><span class="m-wait">Réessaie dans ${left} s</span>`;
        left--;
      };
      tick();
      if (waiting) waitTimer = setInterval(tick, 1000);
    };

    const submit = async (value) => {
      if (!value || busy || waiting) return;
      busy = true;
      cancelBtn.disabled = true;
      card.classList.add("checking");
      err.textContent = "";
      const t0 = Date.now();
      const reply = await runSync(ctx, value, live);
      if (!reply || !live()) return; // succès (résumé affiché) ou écran remplacé
      const rest = MIN_CHECK_MS - (Date.now() - t0);
      if (rest > 0) await sleep(rest);
      if (!live()) return;
      busy = false;
      cancelBtn.disabled = false;
      card.classList.remove("checking");
      showError(reply);
    };

    const input = PP.pinPad.bind(el, { pinLength, onSubmit: submit, blocked: () => busy || waiting });
    if (!isPin) el.querySelector("#pw").focus();
  }

  // ------------------------------------------------------------ résumé
  function summaryScreen(pc, s) {
    const n = (x) => Math.max(0, Number(x) || 0);
    const deleted = n(s.deleted);
    const conflicts = n(s.conflicts);
    const { el } = paint(`
      <div class="m-sync-ok">✓ Synchronisé avec ${esc(pc)}</div>
      <div class="m-sync-sum">↓ ${plural(n(s.to_phone), "reçu", "reçus")} · ↑ ${plural(n(s.to_pc), "envoyé", "envoyés")}</div>
      ${deleted ? `<div class="m-sync-sum">${plural(deleted, "supprimé", "supprimés")}</div>` : ""}
      ${conflicts ? `<div class="m-sync-sum">${conflicts > 1 ? `${conflicts} conflits : copies gardées` : "1 conflit : copie gardée"}</div>` : ""}
      <button type="button" class="btn btn-primary m-wide" id="done">Voir mes comptes</button>`);
    el.querySelector("#done").addEventListener("click", () => {
      PP.state.tab = "accounts";
      PP.route();
    });
  }
})();
