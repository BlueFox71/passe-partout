/* Téléphone — synchronisation avec le PC : scan du QR, hello, code du PC, confirmation de remplacement,
   sync, enregistrement (apply_sync) puis résumé.
   Contrat (décision 14) : V.show(container?) — sans conteneur, plein écran (accueil, données illisibles :
   l'appli n'est pas déverrouillée et n'a pas de données) ; avec un conteneur, dans l'onglet Synchro.
   Le code saisi n'est jamais journalisé ni gardé après l'échange. */
(function () {
  const V = (PP.views.sync = {});
  const PPM = window.PPM;
  const MIN_CHECK_MS = 500; // l'animation de vérification reste visible au moins ce temps
  const RETRY_ERRORS = ["bad_code", "code_required"]; // erreurs du PC après lesquelles seul « sync » est renvoyé

  let container = null; // conteneur de l'onglet, ou null en plein écran
  let seq = 0; // jeton d'affichage : une étape lancée par un écran remplacé s'arrête
  let pending = null; // client dont le hello a réussi mais sans sync aboutie (à annuler si on quitte)
  let waitTimer = null;

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
  function paint(inner) {
    stop();
    const token = seq;
    const html = `<div class="m-card glass m-sync-card">${inner}</div>`;
    let el;
    if (container) {
      container.innerHTML = `<div class="m-sync"><div class="m-head"><h1>Synchro</h1></div>
        <div class="m-sync-body">${html}</div></div>`;
      el = container.firstElementChild;
    } else {
      el = PP.render(`<div class="m-screen m-sync">${PP.brand("big-brand")}${html}</div>`).firstElementChild;
    }
    const live = () => token === seq && el.isConnected;
    return { el, live };
  }

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
  function startScreen(error = "") {
    const { el, live } = paint(`
      <h2>Synchroniser avec le PC</h2>
      <p>Sur le PC : Passe-Partout → « Synchroniser le téléphone », puis vise le QR code.</p>
      <div class="hint" id="last"></div>
      ${error ? `<div class="warn-box" id="err">${esc(error)}</div>` : ""}
      <button type="button" class="btn btn-primary m-wide" id="scan">${PP.icon.sync}Scanner le QR code du PC</button>
      ${container ? "" : `<button type="button" class="m-link" id="back">Retour</button>`}`);
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
      hello = await client.hello(info);
    } catch (e) {
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
    const { client, info, hello } = ctx;
    let reply;
    try {
      const vault = hello.mode === "merge" ? await PP.api.sync_payload() : null;
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
    try {
      await PP.call("apply_sync", { ...reply, pc: hello.pc }, code);
    } catch (e) {
      if (cur()) startScreen("Les données reçues n'ont pas pu être enregistrées sur le téléphone : relance la synchronisation.");
      return null;
    }
    try {
      await PP.refreshState();
    } catch (e) { /* état relu plus tard par PP.route */ }
    if (cur()) summaryScreen(hello.pc, reply.summary || {});
    return null;
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
