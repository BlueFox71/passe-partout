/* Téléphone — onglet Comptes : recherche, filtres (profils, favoris), index A–Z, bouton « + »,
   fiche plein écran (copier, afficher, favori, Modifier).
   Contrat (coquille) : PP.views.accounts.show(conteneur), clear(), focusSearch(), newItem() ;
   PP.views.main (views/shell.js) délègue focusSearch / newItem ici.
   Le formulaire (création, modification, suppression) est dans views/account-form.js. */
(function () {
  const V = (PP.views.accounts = {});
  const S = PP.state;
  const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];
  const COLORS = ["#ff4d6d", "#ff4d6d", "#ffc23d", "#00e5ff", "#3dffb0"];
  const LABELS = ["Très faible", "Faible", "Moyen", "Solide", "Très solide"];

  let root = null; // élément .m-acc de l'onglet affiché
  let accounts = []; // comptes du profil affiché (déchiffrés : oubliés au verrouillage)
  let seq = 0; // jeton d'affichage de l'onglet : une réponse arrivée après un nouvel affichage est ignorée
  let sheetSeq = 0; // jeton de la fiche / du formulaire affiché par-dessus la liste
  let loadSeq = 0; // jeton de chargement : seule la réponse du dernier list_accounts est affichée
  let current = null; // compte de la fiche ouverte
  let revealed = false; // mot de passe affiché en clair sur la fiche

  const esc = (s) => PP.esc(s);
  const live = (token) => token === seq && !!root && root.isConnected;

  // Jauge de force (même rendu que le PC) ; aussi utilisée par le formulaire.
  V.strengthHtml = (pw) => {
    const s = PP.strength(pw);
    return `<div class="strength" style="--c:${COLORS[s]}">${[1, 2, 3, 4].map((i) => `<i class="${i <= s ? "on" : ""}"></i>`).join("")}<span>${LABELS[s]}</span></div>`;
  };

  // Première lettre (sans accent) d'un nom ; « # » pour les chiffres et symboles.
  const letterOf = (name) => {
    const c = PP.normalize(name).charAt(0).toUpperCase();
    return c >= "A" && c <= "Z" ? c : "#";
  };

  const query = () => String(S.query || "");
  const favOnly = () => S.filter === "fav";

  function visible() {
    const list = favOnly() ? accounts.filter((a) => a.favorite) : accounts;
    return PP.search(list, query());
  }

  // ------------------------------------------------------------ affichage de l'onglet
  V.show = (container) => {
    seq++;
    sheetSeq++;
    current = null;
    revealed = false;
    const profiles = S.profiles || [];
    if (S.profileId && (profiles.length < 2 || !profiles.some((p) => p.id === S.profileId))) S.profileId = null;
    if (S.filter !== "fav") S.filter = "all";
    container.innerHTML = `
      <div class="m-acc">
        <div class="m-acc-top">
          <div class="m-head m-acc-head"><h1>Comptes</h1><small id="acc-count"></small></div>
          <div class="search m-search">${PP.icon.search}<input class="input" id="acc-q" type="search"
            placeholder="Rechercher…" value="${esc(query())}" autocomplete="off" autocapitalize="off"
            autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Rechercher un compte"></div>
          <div class="m-chips" id="acc-chips" role="toolbar" aria-label="Filtres"></div>
        </div>
        <div class="m-acc-main">
          <div class="m-acc-list" id="acc-list"></div>
          <div class="m-az" id="acc-az" aria-label="Index alphabétique"></div>
          <button type="button" class="m-fab" id="acc-new" aria-label="Nouveau compte">${PP.icon.plus}</button>
        </div>
        <div class="m-sheet" id="acc-sheet" hidden></div>
      </div>`;
    root = container.firstElementChild;
    const token = seq;

    const q = root.querySelector("#acc-q");
    q.addEventListener("input", () => {
      S.query = q.value;
      renderList();
      root.querySelector("#acc-list").scrollTop = 0;
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") q.blur(); }); // ferme le clavier

    root.querySelector("#acc-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chip]");
      if (!b) return;
      const key = b.dataset.chip;
      if (key === "fav") {
        S.filter = favOnly() ? "all" : "fav";
        renderChips();
        renderList();
      } else {
        const id = key.slice(2) || null;
        if (id === (S.profileId ?? null)) return;
        S.profileId = id;
        renderChips();
        load(token);
      }
      root.querySelector("#acc-list").scrollTop = 0;
    });

    root.querySelector("#acc-list").addEventListener("click", (e) => {
      const it = e.target.closest("[data-id]");
      if (!it) return;
      const a = accounts.find((x) => x.id === it.dataset.id);
      if (a) openDetail(a);
    });

    bindAz(root.querySelector("#acc-az"));
    root.querySelector("#acc-new").addEventListener("click", () => V.newItem());

    renderChips();
    renderList(); // liste vide pendant le chargement
    load(token);
  };

  async function load(token = seq) {
    const mine = ++loadSeq; // deux puces touchées vite : la réponse la plus ancienne est ignorée
    let list;
    try {
      list = await PP.call("list_accounts", S.profileId ?? null);
    } catch (e) {
      return; // erreur déjà signalée par PP.call
    }
    if (!live(token) || mine !== loadSeq) return;
    accounts = list;
    renderList();
  }

  // Au verrouillage (coquille) : plus aucune donnée du coffre, recherche et sélection oubliées.
  V.clear = () => {
    seq++;
    sheetSeq++;
    accounts = [];
    current = null;
    revealed = false;
    S.query = "";
    S.selectedId = null;
    S.filter = "all";
    if (root) root.innerHTML = "";
    root = null;
  };

  const sheetOpen = () => !!root && !root.querySelector("#acc-sheet").hidden;

  // Raccourcis Ctrl+F / Ctrl+N (ui/app.js) : sans effet pendant la fiche ou le formulaire,
  // pour ne pas perdre une saisie en cours.
  V.focusSearch = () => {
    if (!root || sheetOpen()) return;
    const q = root.querySelector("#acc-q");
    q.focus();
    q.select();
  };

  V.newItem = () => {
    if (!root || sheetOpen()) return;
    openForm(null);
  };

  // ------------------------------------------------------------ filtres
  function renderChips() {
    const el = root.querySelector("#acc-chips");
    const profiles = S.profiles || [];
    const chip = (key, label, on, aria = "") =>
      `<button type="button" class="m-chip${on ? " on" : ""}" data-chip="${key}" aria-pressed="${on}"${aria}><span>${label}</span></button>`;
    const pid = S.profileId ?? null;
    el.innerHTML = (profiles.length > 1
      ? chip("p:", "Tout le monde", pid === null) + profiles.map((p) => chip(`p:${esc(p.id)}`, esc(p.name), pid === p.id)).join("")
      : "") + chip("fav", "⭐", favOnly(), ' aria-label="Favoris seulement"');
  }

  // ------------------------------------------------------------ liste
  function renderList() {
    if (!root) return;
    const listEl = root.querySelector("#acc-list");
    const vis = visible();
    root.querySelector("#acc-count").textContent = `${vis.length} compte${vis.length > 1 ? "s" : ""}`;
    if (!vis.length) {
      const msg = query().trim() ? "Aucun compte ne correspond à ta recherche."
        : favOnly() ? "Aucun favori ici pour l'instant." : "Aucun compte ici pour l'instant.";
      listEl.innerHTML = `<div class="empty"><div class="big">🔎</div>${msg}</div>`;
    } else {
      const groups = !favOnly() && !query().trim() && vis.some((a) => a.favorite);
      let html = "";
      let lastFav = null;
      for (const a of vis) {
        if (groups && a.favorite !== lastFav) {
          html += `<div class="group-title">${a.favorite ? "⭐ Favoris" : "Tous"}</div>`;
          lastFav = a.favorite;
        }
        const sub = PP.applyMask(a.login, a.login_mask) || a.category;
        html += `<button type="button" class="item m-item" data-id="${esc(a.id)}">
            ${PP.logo(a)}
            <span class="t"><b>${esc(a.name)}</b><small>${esc(sub)}</small></span>
            ${a.favorite ? `<span class="star" aria-label="Favori">★</span>` : ""}
          </button>`;
      }
      listEl.innerHTML = html;
    }
    renderAz(vis);
  }

  function renderAz(vis) {
    const az = root.querySelector("#acc-az");
    const present = new Set(vis.map((a) => letterOf(a.name)));
    az.classList.toggle("hidden", vis.length < 2);
    az.innerHTML = LETTERS.map((l) => `<b class="${present.has(l) ? "" : "off"}" data-l="${l}">${l}</b>`).join("");
  }

  // Toucher ou glisser le doigt sur l'index : défile jusqu'à la lettre (ou la suivante présente).
  function bindAz(az) {
    let last = null;
    const letterAt = (y) => {
      const r = az.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, y);
      return el && el.closest ? el.closest("[data-l]") : null;
    };
    const pick = (el) => {
      if (!el || !az.contains(el) || el.dataset.l === last) return;
      last = el.dataset.l;
      jumpTo(last);
    };
    az.addEventListener("touchstart", (e) => {
      e.preventDefault(); // pas de clic simulé ni de défilement de la page
      last = null;
      pick(letterAt(e.touches[0].clientY));
    }, { passive: false });
    az.addEventListener("touchmove", (e) => {
      e.preventDefault();
      pick(letterAt(e.touches[0].clientY));
    }, { passive: false });
    az.addEventListener("touchend", () => { last = null; });
    az.addEventListener("click", (e) => {
      const b = e.target.closest("[data-l]");
      if (!b) return;
      last = null;
      pick(b);
      last = null;
    });
  }

  function jumpTo(letter) {
    const vis = visible();
    if (!vis.length) return;
    const present = LETTERS.filter((l) => vis.some((a) => letterOf(a.name) === l));
    const from = LETTERS.indexOf(letter);
    const target = present.find((l) => LETTERS.indexOf(l) >= from) || present[present.length - 1];
    const matches = vis.filter((a) => letterOf(a.name) === target);
    // liste groupée : les favoris sont en tête, on vise la partie alphabétique
    const grouped = !favOnly() && !query().trim();
    const acc = (grouped && matches.find((a) => !a.favorite)) || matches[0];
    const listEl = root.querySelector("#acc-list");
    const el = listEl.querySelector(`[data-id="${CSS.escape(acc.id)}"]`);
    if (!el) return;
    listEl.scrollTop = Math.max(0, el.offsetTop - 6);
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }

  // ------------------------------------------------------------ fiche et formulaire (par-dessus la liste)
  function sheetEl() {
    const sh = root.querySelector("#acc-sheet");
    sh.hidden = false;
    sh.scrollTop = 0;
    return sh;
  }

  function closeSheet() {
    sheetSeq++;
    current = null;
    revealed = false;
    if (!root) return;
    const sh = root.querySelector("#acc-sheet");
    sh.hidden = true;
    sh.innerHTML = "";
  }

  function openDetail(a) {
    sheetSeq++;
    current = a;
    revealed = false;
    drawDetail(true);
  }

  function dateFr(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("fr-FR");
  }

  function drawDetail(top = false) {
    const a = current;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    const sh = root.querySelector("#acc-sheet");
    const keep = sh.scrollTop;
    sheetEl();
    const names = (S.profiles || []).filter((p) => (a.profiles || []).includes(p.id)).map((p) => p.name);
    const login = PP.applyMask(a.login, a.login_mask);
    const pw = revealed ? PP.applyMask(a.password, a.password_mask) : "•".repeat(Math.min(14, Math.max(8, a.password.length)));
    const created = dateFr(a.created);
    const updated = dateFr(a.updated);
    sh.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="d-back">${PP.icon.back}<span>Retour</span></button>
        <button type="button" class="m-ibtn m-fav${a.favorite ? " on" : ""}" id="d-fav" aria-pressed="${!!a.favorite}"
          aria-label="${a.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}">${a.favorite ? PP.icon.starFill : PP.icon.star}</button>
      </div>
      <div class="m-sheet-body">
        <div class="m-detail-head">
          ${PP.logo(a, "xl")}
          <h2 class="selectable">${esc(a.name)}</h2>
          <div class="m-sub">${esc([a.category || "Sans catégorie", ...names].join(" · "))}</div>
        </div>
        <div class="fld m-fld">
          <div class="v"><span class="label">Identifiant</span>
            <div class="val selectable">${login ? esc(login) : '<span class="m-none">—</span>'}</div></div>
          ${a.login ? `<button type="button" class="m-ibtn" id="d-cl" aria-label="Copier l'identifiant">${PP.icon.copy}</button>` : ""}
        </div>
        <div class="fld m-fld">
          <div class="v"><span class="label">Mot de passe</span>
            ${a.password
              ? `<div class="val ${revealed ? "selectable" : "masked"}">${esc(pw)}</div>${V.strengthHtml(a.password)}`
              : '<div class="val"><span class="m-none">—</span></div>'}</div>
          ${a.password ? `<button type="button" class="m-ibtn" id="d-eye" aria-label="${revealed ? "Masquer" : "Afficher"} le mot de passe">${revealed ? PP.icon.eyeOff : PP.icon.eye}</button>
            <button type="button" class="m-ibtn" id="d-cp" aria-label="Copier le mot de passe">${PP.icon.copy}</button>` : ""}
        </div>
        <button type="button" class="btn btn-primary m-wide" id="d-edit">${PP.icon.edit}Modifier</button>
        ${created || updated ? `<div class="m-meta">${created ? `Créé le ${created}` : ""}${created && updated ? " · " : ""}${updated ? `Modifié le ${updated}` : ""}</div>` : ""}
      </div>`;
    sh.scrollTop = top ? 0 : keep;

    sh.querySelector("#d-back").addEventListener("click", closeSheet);
    sh.querySelector("#d-edit").addEventListener("click", () => openForm(a));
    const cl = sh.querySelector("#d-cl");
    if (cl) cl.addEventListener("click", () => PP.copyPlain(a.login).catch(() => {}));
    const cp = sh.querySelector("#d-cp");
    if (cp) cp.addEventListener("click", () => PP.copySecret(a.password).catch(() => {}));
    const eye = sh.querySelector("#d-eye");
    if (eye) eye.addEventListener("click", () => { revealed = !revealed; drawDetail(); });
    const fav = sh.querySelector("#d-fav");
    fav.addEventListener("click", async () => {
      fav.disabled = true;
      let saved;
      try {
        saved = await PP.call("save_account", { ...a, favorite: !a.favorite });
      } catch (e) {
        if (sheetLive()) fav.disabled = false;
        return;
      }
      if (!sheetLive()) return;
      current = saved;
      drawDetail();
      load(token);
    });
  }

  function openForm(account) {
    sheetSeq++;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    current = account;
    revealed = false;
    PP.views.accountForm.open(sheetEl(), account, {
      live: sheetLive,
      onCancel: () => (account ? openDetail(account) : closeSheet()),
      onSaved: async (saved) => {
        PP.toast(account ? "Compte modifié" : "Compte ajouté");
        const pid = S.profileId ?? null;
        if (!account && pid && !(saved.profiles || []).includes(pid)) PP.toast("Ce compte n'appartient pas au profil affiché");
        openDetail(saved);
        await load(token);
      },
      onDeleted: async () => {
        PP.toast("Compte supprimé");
        closeSheet();
        await load(token);
      },
    });
  }
})();
