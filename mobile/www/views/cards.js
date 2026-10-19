/* Téléphone — onglet Cartes : alerte d'expiration (30 jours), liste (cartes terminées en bas, estompées),
   fiche plein écran (code et PIN masqués, solde, « J'ai dépensé… », historique, Modifier / Supprimer)
   et formulaire. Contrat (coquille) : PP.views.cards.show(conteneur), clear().
   Le solde n'est jamais calculé ici : une dépense passe par spend(id, montant) de l'API locale. */
(function () {
  const V = (PP.views.cards = {});
  const S = PP.state;
  const L = PPM.vault;
  const esc = (s) => PP.esc(s);

  let root = null; // élément .m-gc de l'onglet affiché
  let cards = []; // cartes du profil affiché (déchiffrées : oubliées au verrouillage)
  let seq = 0; // jeton d'affichage de l'onglet : une réponse arrivée après un nouvel affichage est ignorée
  let sheetSeq = 0; // jeton de la fiche / du formulaire affiché par-dessus la liste
  let loadSeq = 0; // jeton de chargement : seule la réponse du dernier list_giftcards est affichée
  let current = null; // carte de la fiche ouverte
  let shown = { code: false, pin: false }; // code / PIN affichés en clair sur la fiche
  let bannerClosed = false; // alerte d'expiration masquée jusqu'au prochain verrouillage

  const live = (token) => token === seq && !!root && root.isConnected;
  const finished = (g) => L.isFinished(g, PP.todayIso());
  const hideSecrets = () => { shown = { code: false, pin: false }; };

  // Montant saisi : « 12,50 », « 12.5 », « 12 € » → 12.5 (arrondi au centime) ; null si vide, NaN si illisible.
  function parseAmount(s) {
    const t = String(s ?? "").replace(/[\s  €]/g, "").replace(",", ".");
    if (!t) return null;
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    return Math.round(Number(t) * 100) / 100;
  }
  const amountText = (n) => (n == null ? "" : String(n).replace(".", ","));

  // Fin de validité : même texte que le PC ; `soon` si elle tombe dans les 30 jours.
  function endInfo(g) {
    if (!g.end_date) return { text: "Sans date de fin", soon: false };
    const d = PP.daysUntil(g.end_date);
    if (d < 0) return { text: `Expirée le ${PP.dateFr(g.end_date)}`, soon: false };
    const soon = d <= 30 && !finished(g);
    const when = d === 0 ? " (aujourd'hui)" : ` (dans ${d} j)`;
    return { text: `${soon ? "⏰ " : ""}Expire le ${PP.dateFr(g.end_date)}${soon ? when : ""}`, soon };
  }

  // ------------------------------------------------------------ affichage de l'onglet
  V.show = (container) => {
    seq++;
    sheetSeq++;
    current = null;
    hideSecrets();
    PP.mui.checkProfileFilter();
    container.innerHTML = `
      <div class="m-acc m-gc">
        <div class="m-acc-top">
          <div class="m-head m-acc-head"><h1>Cartes</h1><small id="gc-count"></small></div>
          <div class="m-chips" id="gc-chips" role="toolbar" aria-label="Profils"></div>
          <div id="gc-banner"></div>
        </div>
        <div class="m-acc-main">
          <div class="m-gc-list" id="gc-list"></div>
          <button type="button" class="m-fab m-gc-fab" id="gc-new" aria-label="Nouvelle carte">${PP.icon.plus}</button>
        </div>
        <div class="m-sheet" id="gc-sheet" hidden></div>
      </div>`;
    root = container.firstElementChild;
    const token = seq;

    root.querySelector("#gc-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chip]");
      if (!b || !PP.mui.pickProfile(b.dataset.chip)) return;
      renderChips();
      root.querySelector("#gc-list").scrollTop = 0;
      load(token);
    });

    root.querySelector("#gc-banner").addEventListener("click", (e) => {
      if (e.target.closest("#gc-bx")) {
        bannerClosed = true;
        renderBanner();
        return;
      }
      const see = e.target.closest("[data-open]");
      const g = see && cards.find((x) => x.id === see.dataset.open);
      if (g) openDetail(g);
    });

    root.querySelector("#gc-list").addEventListener("click", (e) => {
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const g = cards.find((x) => x.id === it.dataset.id);
      if (g) openDetail(g);
    });

    root.querySelector("#gc-new").addEventListener("click", () => openForm(null));

    renderChips();
    renderList(); // liste vide pendant le chargement
    load(token);
  };

  async function load(token = seq) {
    const mine = ++loadSeq; // deux puces touchées vite : la réponse la plus ancienne est ignorée
    let list;
    try {
      list = await PP.call("list_giftcards", S.profileId ?? null);
    } catch (e) {
      return; // erreur déjà signalée par PP.call
    }
    if (!live(token) || mine !== loadSeq) return;
    cards = list;
    renderList();
  }

  // Au verrouillage (coquille) : plus aucune donnée du coffre ni code / PIN affiché.
  V.clear = () => {
    seq++;
    sheetSeq++;
    cards = [];
    current = null;
    hideSecrets();
    bannerClosed = false;
    if (root) root.innerHTML = "";
    root = null;
  };

  function renderChips() {
    root.querySelector("#gc-chips").innerHTML = PP.mui.profileChips();
  }

  // ------------------------------------------------------------ alerte et liste
  function renderBanner() {
    const el = root.querySelector("#gc-banner");
    const soon = L.expiringSoon(cards, PP.todayIso(), 30).sort((a, b) => a.end_date.localeCompare(b.end_date));
    if (!soon.length || bannerClosed) {
      el.innerHTML = "";
      return;
    }
    const one = soon.length === 1 ? soon[0] : null;
    el.innerHTML = `
      <div class="banner m-banner" role="status"><span aria-hidden="true">⏰</span>
        <div class="m-banner-t">${one
          ? `La carte <b>${esc(one.name)}</b> expire le ${PP.dateFr(one.end_date)} (${PP.money(one.remaining)} restants).`
          : `${soon.length} cartes cadeaux expirent dans les 30 prochains jours.`}</div>
        ${one ? `<button type="button" class="btn btn-ghost m-banner-see" data-open="${esc(one.id)}">Voir</button>` : ""}
        <button type="button" class="m-banner-x" id="gc-bx" aria-label="Masquer l'alerte">✕</button>
      </div>`;
  }

  function row(g, done) {
    const end = endInfo(g);
    return `<button type="button" class="item m-item m-gc-item${done ? " done" : ""}" data-id="${esc(g.id)}">
        ${PP.logo(g)}
        <span class="t"><b>${esc(g.name)}</b><small class="${end.soon ? "soon" : ""}">${esc(end.text)}</small></span>
        <span class="m-gc-amt">${PP.money(g.remaining)}</span>
      </button>`;
  }

  function renderList() {
    if (!root) return;
    const active = cards.filter((g) => !finished(g))
      .sort((a, b) => (a.end_date || "9999").localeCompare(b.end_date || "9999"));
    const done = cards.filter(finished).sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
    const total = active.reduce((s, g) => s + g.remaining, 0);
    root.querySelector("#gc-count").textContent =
      `${active.length} active${active.length > 1 ? "s" : ""} · ${PP.money(total)} disponibles`;
    renderBanner();
    const listEl = root.querySelector("#gc-list");
    if (!cards.length) {
      listEl.innerHTML = `<div class="empty"><div class="big">🎁</div>Aucune carte cadeau ici pour l'instant.</div>`;
      return;
    }
    listEl.innerHTML = (active.length ? active.map((g) => row(g, false)).join("")
        : `<div class="empty m-gc-none">Aucune carte cadeau active.</div>`)
      + (done.length ? `<div class="group-title">Terminées (${done.length})</div>${done.map((g) => row(g, true)).join("")}` : "");
  }

  // ------------------------------------------------------------ fiche et formulaire (par-dessus la liste)
  const sheetEl = () => PP.mui.showSheet(root.querySelector("#gc-sheet"));

  function closeSheet() {
    sheetSeq++;
    current = null;
    hideSecrets();
    if (root) PP.mui.hideSheet(root.querySelector("#gc-sheet"));
  }

  function openDetail(g) {
    sheetSeq++;
    current = g;
    hideSecrets();
    drawDetail(true);
  }

  function secretRow(label, value, key) {
    if (!value) {
      return `<div class="fld m-fld"><div class="v"><span class="label">${label}</span>
        <div class="val"><span class="m-none">—</span></div></div></div>`;
    }
    const on = shown[key];
    const what = key === "code" ? "le code" : "le PIN";
    return `<div class="fld m-fld">
        <div class="v"><span class="label">${label}</span>
          <div class="val ${on ? "selectable" : "masked"}">${on ? esc(value) : "•".repeat(Math.min(16, Math.max(4, String(value).length)))}</div></div>
        <button type="button" class="m-ibtn" data-eye="${key}" aria-label="${on ? "Masquer" : "Afficher"} ${what}">${on ? PP.icon.eyeOff : PP.icon.eye}</button>
        <button type="button" class="m-ibtn" data-copy="${key}" aria-label="Copier ${what}">${PP.icon.copy}</button>
      </div>`;
  }

  function drawDetail(top = false) {
    const g = current;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    const sh = root.querySelector("#gc-sheet");
    const keep = sh.scrollTop;
    sheetEl();
    const end = endInfo(g);
    const done = finished(g);
    const canSpend = g.remaining > 0;
    const history = [...(g.history || [])].reverse();
    sh.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="d-back">${PP.icon.back}<span>Retour</span></button>
      </div>
      <div class="m-sheet-body">
        <div class="m-detail-head">
          ${PP.logo(g, "xl")}
          <h2 class="selectable">${esc(g.name)}</h2>
          <div class="m-sub">${esc(PP.mui.profileNames(g).join(" · "))}</div>
          <div class="m-gc-end${end.soon ? " soon" : ""}">${esc(end.text)}</div>
        </div>
        <div class="gc m-gc-bal${done ? " done" : ""}">
          <div class="hint">Solde restant</div>
          <div class="amount">${PP.money(g.remaining)}</div>
          ${g.initial ? `<div class="hint">sur ${PP.money(g.initial)}</div>` : ""}
        </div>
        ${secretRow("Code", g.code, "code")}
        ${g.pin ? secretRow("PIN", g.pin, "pin") : ""}
        ${canSpend ? `
        <form class="m-spend" id="d-spend" novalidate autocomplete="off">
          <label class="label" for="d-amt">Montant dépensé (€)</label>
          <div class="m-spend-row">
            <input class="input m-in" id="d-amt" type="text" inputmode="decimal" placeholder="Ex. 12,50"
              autocomplete="off" enterkeyhint="done">
            <button type="submit" class="btn btn-primary" id="d-go">J'ai dépensé…</button>
          </div>
          <div class="err" id="d-err" role="alert"></div>
        </form>` : ""}
        ${history.length ? `<div class="history m-history"><div class="label">Historique</div>
          ${history.map((h) => `<div><span>${PP.dateFr(h.date)}</span><span>− ${PP.money(h.amount)}</span></div>`).join("")}</div>` : ""}
        <button type="button" class="btn btn-primary m-wide" id="d-edit">${PP.icon.edit}Modifier</button>
        <button type="button" class="btn btn-danger m-wide" id="d-del">${PP.icon.trash}Supprimer la carte</button>
        ${g.updated ? `<div class="m-meta">Modifiée le ${PP.dateFr(String(g.updated).slice(0, 10))}</div>` : ""}
      </div>`;
    sh.scrollTop = top ? 0 : keep;

    const $ = (sel) => sh.querySelector(sel);
    $("#d-back").addEventListener("click", closeSheet);
    $("#d-edit").addEventListener("click", () => openForm(g));
    sh.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => {
      shown[b.dataset.eye] = !shown[b.dataset.eye];
      drawDetail();
    }));
    sh.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
      const code = b.dataset.copy === "code";
      PP.copySecret(code ? g.code : g.pin, code ? "Code" : "PIN").catch(() => {});
    }));

    let busy = false;
    const setBusy = (v) => {
      busy = v;
      sh.querySelectorAll("#d-go, #d-edit, #d-del").forEach((b) => { b.disabled = v; });
    };

    const form = $("#d-spend");
    if (form) {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (busy) return;
        const err = $("#d-err");
        const v = parseAmount($("#d-amt").value);
        if (!(v > 0)) { err.textContent = "Indique un montant positif."; return; }
        if (v > g.remaining + 1e-9) { err.textContent = "C'est plus que le solde restant."; return; }
        err.textContent = "";
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // ferme le clavier
        setBusy(true);
        let saved;
        try {
          saved = await PP.call("spend", g.id, v);
        } catch (ex) {
          if (sheetLive()) setBusy(false); // message déjà affiché par PP.call
          return;
        }
        if (!sheetLive()) return;
        current = saved;
        hideSecrets(); // code et PIN remasqués : la carte a servi, ils n'ont plus à rester à l'écran
        PP.toast(`Nouveau solde : ${PP.money(saved.remaining)}`);
        drawDetail();
        load(token);
      });
    }

    $("#d-del").addEventListener("click", async () => {
      if (busy) return;
      const ok = await PP.confirm(`Supprimer la carte « ${g.name} » ?`,
        "Cette carte sera supprimée de ce téléphone, puis du PC à la prochaine synchronisation.",
        { ok: "Supprimer", danger: true });
      if (!ok || !sheetLive()) return;
      setBusy(true);
      try {
        await PP.call("delete_giftcard", g.id);
      } catch (ex) {
        if (sheetLive()) setBusy(false);
        return;
      }
      if (!sheetLive()) return;
      PP.toast("Carte supprimée");
      closeSheet();
      load(token);
    });
  }

  function openForm(card) {
    sheetSeq++;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    current = card;
    hideSecrets();
    const host = sheetEl();
    // Fiche existante : objet complet (historique, image… conservés) ; l'horodatage est posé par l'API locale.
    const g = card
      ? { ...card }
      : { id: null, name: "", code: "", pin: "", initial: null, remaining: 0, end_date: null, image: null, profiles: [], history: [] };
    const profs = new Set(card ? g.profiles || [] : PP.mui.defaultProfiles());
    let busy = false;

    host.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="c-cancel">${PP.icon.back}<span>Annuler</span></button>
        <div class="m-bar-title">${card ? "Modifier la carte" : "Nouvelle carte cadeau"}</div>
      </div>
      <form class="m-sheet-body m-form" id="c-form" novalidate autocomplete="off">
        ${PP.mui.nameField(g.name, "Ex. Fnac, Amazon, Decathlon…")}
        <div class="field">
          <label for="c-code">Code</label>
          <input class="input m-in m-mono" id="c-code" value="${esc(g.code)}" autocomplete="off"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">
        </div>
        <div class="field">
          <label for="c-pin">PIN</label>
          <input class="input m-in m-mono" id="c-pin" value="${esc(g.pin || "")}" autocomplete="off"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">
        </div>
        <div class="m-two">
          <div class="field">
            <label for="c-init">Montant initial (€)</label>
            <input class="input m-in" id="c-init" type="text" inputmode="decimal" value="${esc(amountText(g.initial))}"
              placeholder="Ex. 50" autocomplete="off" enterkeyhint="next">
          </div>
          <div class="field">
            <label for="c-rem">Solde (€)</label>
            <input class="input m-in" id="c-rem" type="text" inputmode="decimal" value="${card ? esc(amountText(g.remaining)) : ""}"
              placeholder="Ex. 50" autocomplete="off" enterkeyhint="next">
          </div>
        </div>
        <div class="field">
          <label for="c-end">Date de fin <span class="m-opt-l">(facultatif)</span></label>
          <input class="input m-in" id="c-end" type="date" value="${esc(g.end_date || "")}">
        </div>
        <div class="field">
          <label>Profils</label>
          <div class="checks m-checks" id="c-profs"></div>
        </div>
        <div class="err" id="c-err" role="alert"></div>
        <button type="submit" class="btn btn-primary m-wide" id="c-save">${PP.icon.check}Enregistrer</button>
      </form>`;

    const $ = (sel) => host.querySelector(sel);
    const { input: name, closeSug } = PP.mui.bindNameField(host, g, "#c-code");
    const err = $("#c-err");
    const init = $("#c-init");
    const rem = $("#c-rem");
    PP.mui.profileChecks($("#c-profs"), profs);

    // Nouvelle carte : le solde suit le montant initial tant qu'on ne l'a pas touché (comme sur le PC).
    let remTouched = !!card;
    init.addEventListener("input", () => { if (!remTouched) rem.value = init.value; });
    rem.addEventListener("input", () => { remTouched = true; });

    $("#c-cancel").addEventListener("click", () => {
      if (busy) return;
      if (card) openDetail(card);
      else closeSheet();
    });

    $("#c-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      closeSug();
      const initial = parseAmount(init.value);
      const remaining = parseAmount(rem.value);
      const rec = {
        ...g,
        name: name.value.trim(),
        code: $("#c-code").value.trim(),
        pin: $("#c-pin").value.trim(),
        initial,
        remaining: remaining ?? 0,
        end_date: $("#c-end").value || null,
        profiles: [...profs],
      };
      delete rec.updated; // horodatage posé par l'API locale
      if (!rec.name) { err.textContent = "Le nom est obligatoire."; name.focus(); return; }
      if (Number.isNaN(initial) || Number.isNaN(remaining)) { err.textContent = "Montant invalide."; return; }
      if (rec.remaining < 0 || (rec.initial != null && rec.initial < 0)) {
        err.textContent = "Les montants ne peuvent pas être négatifs.";
        return;
      }
      if (!rec.profiles.length) { err.textContent = "Choisis au moins un profil."; return; }
      err.textContent = "";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // ferme le clavier
      busy = true;
      $("#c-save").disabled = true;
      let saved;
      try {
        saved = await PP.call("save_giftcard", rec);
      } catch (ex) {
        if (sheetLive()) { busy = false; $("#c-save").disabled = false; } // message déjà affiché par PP.call
        return;
      }
      if (!sheetLive()) return;
      PP.toast(card ? "Carte modifiée" : "Carte ajoutée");
      const pid = S.profileId ?? null;
      if (!card && pid && !(saved.profiles || []).includes(pid)) PP.toast("Cette carte n'appartient pas au profil affiché");
      openDetail(saved);
      load(token);
    });

    if (!card) name.focus();
  }
})();
