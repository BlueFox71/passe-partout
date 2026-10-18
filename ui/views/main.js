/* Écran principal : navigation, recherche, liste des comptes et fiche détaillée. */
(function () {
  const V = (PP.views.main = {});
  const S = PP.state;
  let accounts = [];
  let giftcards = [];
  let revealed = false;
  let selecting = false;
  let checked = new Set();
  let bannerClosed = false;

  V.active = () => !!document.getElementById("main-layout") && !S.locked;

  V.show = async () => {
    S.view = S.view || "accounts";
    await V.reload();
    renderLayout();
  };

  V.reload = async () => {
    [accounts, giftcards] = await Promise.all([
      PP.call("list_accounts", S.profileId ?? null),
      PP.call("list_giftcards", S.profileId ?? null),
    ]);
  };
  V.giftcards = () => giftcards;

  // Au verrouillage : oublie les données déchiffrées gardées par l'interface.
  V.clear = () => {
    accounts = [];
    giftcards = [];
    checked.clear();
    selecting = false;
    revealed = false;
    S.selectedId = null;
  };

  const currentProfile = () => S.profiles.find((p) => p.id === S.profileId) || null;

  // Catégories regroupées sans tenir compte de la casse ni des accents (« Banque » = « banque »).
  const catOf = (a) => a.category || "Sans catégorie";
  function categories() {
    const m = new Map();
    for (const a of accounts) {
      const k = PP.normalize(catOf(a));
      const cur = m.get(k);
      m.set(k, cur ? [cur[0], cur[1] + 1] : [catOf(a), 1]);
    }
    return [...m.values()].sort((a, b) => a[0].localeCompare(b[0], "fr", { sensitivity: "base" }));
  }

  // Liste affichée = filtre de navigation + recherche (c'est aussi ce qui est exporté).
  V.visible = () => {
    let list = accounts;
    if (S.filter === "fav") list = list.filter((a) => a.favorite);
    else if (S.filter.startsWith("cat:")) list = list.filter((a) => PP.normalize(catOf(a)) === PP.normalize(S.filter.slice(4)));
    return PP.search(list, S.query);
  };

  function expiringCards() {
    const today = PP.todayIso();
    return giftcards.filter((g) => g.remaining > 0 && g.end_date && g.end_date >= today && PP.daysUntil(g.end_date) <= 30);
  }

  function renderLayout() {
    const prof = currentProfile();
    const favCount = accounts.filter((a) => a.favorite).length;
    const soon = expiringCards();
    const app = PP.render(`
      <div class="layout" id="main-layout">
        <aside class="nav">
          ${PP.brand()}
          <div class="nav-profile" id="switch" title="Changer de profil">
            ${prof ? PP.avatar(prof) : `<div class="logo" style="background:conic-gradient(from 200deg,#ff3d9a,#7c3aed,#00e5ff,#ff3d9a)">${PP.icon.users.replace("<svg", '<svg style="width:18px"')}</div>`}
            <div><div style="font-weight:600">${PP.esc(prof ? prof.name : "Tout le monde")}</div><small>Changer de profil</small></div>
          </div>
          <div class="nav-item ${navOn("accounts", "fav")}" data-f="fav">${PP.icon.star}Favoris<span class="c">${favCount}</span></div>
          <div class="nav-item ${navOn("accounts", "all")}" data-f="all">${PP.icon.grid}Tous<span class="c">${accounts.length}</span></div>
          <div class="nav-section">Catégories</div>
          <div class="nav-cats">
            ${categories().map(([c, n]) => `<div class="nav-item ${navOn("accounts", "cat:" + c)}" data-f="cat:${PP.esc(c)}">${PP.icon.tag}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${PP.esc(c)}</span><span class="c">${n}</span></div>`).join("")}
          </div>
          <div class="nav-bottom">
            <div class="nav-item ${S.view === "giftcards" ? "on" : ""}" data-v="giftcards">${PP.icon.gift}Cartes cadeaux${soon.length ? `<span class="badge">${soon.length}</span>` : `<span class="c">${giftcards.length}</span>`}</div>
            <div class="nav-item ${S.view === "settings" ? "on" : ""}" data-v="settings">${PP.icon.gear}Réglages</div>
            ${S.lock_mode !== "none" ? `<div class="nav-item" id="lock">${PP.icon.lock}Verrouiller</div>` : ""}
          </div>
        </aside>
        <section class="main">
          <div class="topbar">
            <div class="search">${PP.icon.search}<input class="input" id="q" placeholder="Rechercher un compte, un identifiant, une catégorie…" value="${PP.esc(S.query)}"><kbd>Ctrl F</kbd></div>
            <div class="spacer"></div>
            <button class="btn btn-ghost" id="export">${PP.icon.export} Exporter</button>
            <button class="btn btn-primary" id="new">${PP.icon.plus} Nouveau</button>
          </div>
          ${soon.length && !bannerClosed ? `<div class="banner">⏰ <div>${soon.length === 1
              ? `La carte <b>${PP.esc(soon[0].name)}</b> expire le ${PP.dateFr(soon[0].end_date)} (${PP.money(soon[0].remaining)} restants).`
              : `${soon.length} cartes cadeaux expirent dans les 30 prochains jours.`}</div>
              <button class="btn btn-ghost" data-v="giftcards" style="padding:5px 12px">Voir</button><span class="x" id="xb">✕</span></div>` : ""}
          <div class="content" id="content"></div>
        </section>
      </div>`);

    app.querySelector("#switch").addEventListener("click", () => { S.profileId = undefined; S.view = "accounts"; PP.views.profiles.show(); });
    app.querySelectorAll("[data-f]").forEach((n) =>
      n.addEventListener("click", () => { S.view = "accounts"; S.filter = n.dataset.f; S.selectedId = null; renderLayout(); })
    );
    app.querySelectorAll("[data-v]").forEach((n) => n.addEventListener("click", () => { S.view = n.dataset.v; renderLayout(); }));
    const lock = app.querySelector("#lock");
    if (lock) lock.addEventListener("click", PP.lockNow);
    const xb = app.querySelector("#xb");
    if (xb) xb.addEventListener("click", () => { bannerClosed = true; renderLayout(); });
    const q = app.querySelector("#q");
    q.addEventListener("input", () => {
      S.query = q.value;
      if (S.view !== "accounts") { S.view = "accounts"; renderLayout(); V.focusSearch(false); return; }
      renderList();
    });
    app.querySelector("#new").addEventListener("click", V.newItem);
    app.querySelector("#export").addEventListener("click", () =>
      PP.views.export.open(S.view === "accounts" ? V.visible() : accounts, giftcards)
    );
    renderContent();
  }

  function navOn(view, filter) { return S.view === view && S.filter === filter ? "on" : ""; }

  function renderContent() {
    const c = document.getElementById("content");
    if (S.view === "giftcards") return PP.views.giftcards.render(c, giftcards);
    if (S.view === "settings") return PP.views.settings.render(c);
    c.innerHTML = `<div class="list ${isGrid() ? "grid-mode" : ""}"><div class="list-head"></div>
        <div class="list-body"><div class="list-scroll" id="list"></div><div class="az" id="az"></div></div>
        <div id="bulk"></div></div>${isGrid() ? "" : `<div class="detail" id="detail"></div>`}`;
    renderList();
  }

  const isGrid = () => (S.settings && S.settings.view) === "grid";

  async function setView(view) {
    S.settings = await PP.call("save_settings", { view });
    renderContent();
  }

  // Première lettre (sans accent) d'un nom ; « # » pour les chiffres et symboles.
  const letterOf = (name) => {
    const c = PP.normalize(name).charAt(0).toUpperCase();
    return c >= "A" && c <= "Z" ? c : "#";
  };

  function renderAz(vis) {
    const az = document.getElementById("az");
    if (!az) return;
    const present = new Set(vis.map((a) => letterOf(a.name)));
    az.innerHTML = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"].map((l) =>
      `<b class="${present.has(l) ? "" : "off"}" data-l="${l}">${l}</b>`).join("");
    az.querySelectorAll("b:not(.off)").forEach((b) => b.addEventListener("click", () => jumpTo(b.dataset.l)));
  }

  // Va au premier compte de la lettre (dans la partie alphabétique, après les favoris si besoin).
  function jumpTo(letter) {
    const vis = V.visible();
    const matches = vis.filter((a) => letterOf(a.name) === letter);
    if (!matches.length) return;
    const grouped = S.filter === "all" && !S.query;
    const target = (grouped && matches.find((a) => !a.favorite)) || matches[0];
    if (!isGrid() && !selecting) { S.selectedId = target.id; revealed = false; renderList(); }
    const el = document.querySelector(`#list [data-id="${CSS.escape(target.id)}"]`);
    if (el) {
      el.scrollIntoView({ block: "start", behavior: "smooth" });
      el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    }
  }

  function title() {
    if (S.filter === "fav") return "Favoris";
    if (S.filter.startsWith("cat:")) return S.filter.slice(4);
    return "Tous les comptes";
  }

  function renderList() {
    const listEl = document.getElementById("list");
    if (!listEl) return;
    const vis = V.visible();
    if (S.selectedId && !vis.some((a) => a.id === S.selectedId)) S.selectedId = null;
    if (!S.selectedId && vis.length && !selecting) S.selectedId = vis[0].id;
    document.querySelector(".list-head").innerHTML = `
      <div><h2>${PP.esc(title())}</h2><small>${vis.length} compte${vis.length > 1 ? "s" : ""}</small></div>
      <div class="row" style="gap:6px">
        <div class="seg view-seg"><button data-view="list" class="${isGrid() ? "" : "on"}" title="Vue liste">${PP.icon.list}</button><button data-view="grid" class="${isGrid() ? "on" : ""}" title="Vue grille">${PP.icon.grid}</button></div>
        <button class="icon-btn ${selecting ? "on" : ""}" id="sel" title="Sélection multiple">${PP.icon.select}</button>
      </div>`;
    document.getElementById("sel").addEventListener("click", () => { selecting = !selecting; checked.clear(); renderList(); });
    document.querySelectorAll(".view-seg [data-view]").forEach((b) => b.addEventListener("click", () => {
      if ((b.dataset.view === "grid") !== isGrid()) setView(b.dataset.view);
    }));

    if (!vis.length) {
      listEl.innerHTML = `<div class="empty"><div class="big">🔎</div>${S.query ? "Aucun compte ne correspond à ta recherche." : "Aucun compte ici pour l'instant."}</div>`;
    } else {
      const showGroups = S.filter === "all" && !S.query;
      const grid = isGrid();
      let html = "", lastFav = null;
      const close = () => { if (grid && html) html += "</div>"; };
      for (const a of vis) {
        if ((showGroups && a.favorite !== lastFav) || (grid && !html)) {
          close();
          if (showGroups) html += `<div class="group-title">${a.favorite ? "⭐ Favoris" : "Tous"}</div>`;
          if (grid) html += `<div class="tiles">`;
          lastFav = a.favorite;
        }
        const cls = selecting ? (checked.has(a.id) ? "checked" : "") : (!grid && a.id === S.selectedId ? "on" : "");
        const ck = selecting ? `<div class="ck">${checked.has(a.id) ? "✓" : ""}</div>` : "";
        const sub = PP.esc(PP.applyMask(a.login, a.login_mask) || a.category);
        html += grid
          ? `<div class="item tile ${cls}" data-id="${PP.esc(a.id)}">${ck}
              ${a.favorite ? `<span class="star">★</span>` : ""}${PP.logo(a, "lg")}
              <b>${PP.esc(a.name)}</b><small>${sub}</small></div>`
          : `<div class="item ${cls}" data-id="${PP.esc(a.id)}">${ck}
              ${PP.logo(a)}
              <div class="t"><b>${PP.esc(a.name)}</b><small>${sub}</small></div>
              ${a.favorite ? `<span class="star">★</span>` : ""}
            </div>`;
      }
      close();
      listEl.innerHTML = html;
      listEl.querySelectorAll(".item").forEach((it) =>
        it.addEventListener("click", () => {
          const id = it.dataset.id;
          if (selecting) { checked.has(id) ? checked.delete(id) : checked.add(id); }
          else if (isGrid()) { revealed = false; return openDetail(accounts.find((a) => a.id === id)); }
          else { S.selectedId = id; revealed = false; }
          renderList();
        })
      );
      listEl.querySelectorAll(".item").forEach((it) =>
        it.addEventListener("dblclick", () => { if (!selecting) PP.views.form.openAccount(accounts.find((a) => a.id === it.dataset.id)); })
      );
    }
    renderAz(vis);
    renderBulk();
    renderDetail();
  }

  function renderBulk() {
    const b = document.getElementById("bulk");
    if (!selecting) { b.innerHTML = ""; return; }
    const profs = S.profiles;
    b.innerHTML = `<div class="bulkbar">
      <b style="color:var(--cyan)">${checked.size} sélectionné${checked.size > 1 ? "s" : ""}</b>
      <button class="btn btn-ghost" id="b-all" style="padding:6px 10px">Tout</button>
      <div style="flex-basis:100%"></div>
      <button class="btn btn-ghost" id="b-cat" style="padding:6px 10px" ${checked.size ? "" : "disabled"}>${PP.icon.tag}Catégorie</button>
      ${profs.length > 1 ? `<button class="btn btn-ghost" id="b-prof" style="padding:6px 10px" ${checked.size ? "" : "disabled"}>${PP.icon.users}Profils</button>` : ""}
    </div>`;
    b.querySelector("#b-all").addEventListener("click", () => {
      const vis = V.visible();
      if (checked.size === vis.length) checked.clear(); else vis.forEach((a) => checked.add(a.id));
      renderList();
    });
    const cat = b.querySelector("#b-cat");
    cat.addEventListener("click", () => bulkCategory());
    const pr = b.querySelector("#b-prof");
    if (pr) pr.addEventListener("click", () => bulkProfiles());
  }

  function bulkCategory() {
    const cats = categories().map(([c]) => c);
    const m = PP.modal.open(`
      <h2>Changer la catégorie</h2>
      <div class="field"><label>Nouvelle catégorie pour ${checked.size} compte(s)</label>
        <input class="input" id="bc" list="bcl" placeholder="Ex. Banque"><datalist id="bcl">${cats.map((c) => `<option value="${PP.esc(c)}">`).join("")}</datalist></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="no">Annuler</button><button class="btn btn-primary" id="ok">Appliquer</button></div>`, { cls: "sm" });
    m.querySelector("#bc").focus();
    m.querySelector("#no").addEventListener("click", () => PP.modal.close());
    m.querySelector("#ok").addEventListener("click", async () => {
      const v = m.querySelector("#bc").value.trim();
      if (!v) return;
      await PP.call("bulk_update", [...checked], { category: v });
      PP.modal.close();
      PP.toast("Catégorie mise à jour");
      await V.afterChange();
    });
  }

  function bulkProfiles() {
    const state = {}; // id -> "add" | "remove" | undefined
    const m = PP.modal.open(`
      <h2>Profils de ${checked.size} compte(s)</h2>
      <p class="hint" style="margin:0 0 14px">Clique une fois pour <b style="color:var(--ok)">ajouter</b> au profil, deux fois pour <b style="color:#ff9db0">retirer</b>.
        Un compte garde toujours au moins un profil.</p>
      <div class="checks" id="bp"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="no">Annuler</button><button class="btn btn-primary" id="ok">Appliquer</button></div>`, { cls: "sm" });
    const draw = () => {
      m.querySelector("#bp").innerHTML = S.profiles.map((p) => {
        const st = state[p.id];
        const style = st === "add" ? "border-color:var(--ok);background:rgba(61,255,176,.12)" : st === "remove" ? "border-color:var(--danger);background:rgba(255,77,109,.12);text-decoration:line-through" : "";
        return `<div class="check" data-p="${PP.esc(p.id)}" style="${style}">${PP.avatar(p)}${PP.esc(p.name)}${st === "add" ? " +" : st === "remove" ? " −" : ""}</div>`;
      }).join("");
      m.querySelectorAll("[data-p]").forEach((c) => c.addEventListener("click", () => {
        const id = c.dataset.p;
        state[id] = state[id] === undefined ? "add" : state[id] === "add" ? "remove" : undefined;
        draw();
      }));
    };
    draw();
    m.querySelector("#no").addEventListener("click", () => PP.modal.close());
    m.querySelector("#ok").addEventListener("click", async () => {
      const add = Object.keys(state).filter((k) => state[k] === "add");
      const remove = Object.keys(state).filter((k) => state[k] === "remove");
      await PP.call("bulk_update", [...checked], { add_profiles: add, remove_profiles: remove });
      PP.modal.close();
      PP.toast("Profils mis à jour");
      await V.afterChange();
    });
  }

  function strengthHtml(pw) {
    const s = PP.strength(pw);
    const colors = ["#ff4d6d", "#ff4d6d", "#ffc23d", "#00e5ff", "#3dffb0"];
    const labels = ["Très faible", "Faible", "Moyen", "Solide", "Très solide"];
    return `<div class="strength" style="--c:${colors[s]}">${[1, 2, 3, 4].map((i) => `<i class="${i <= s ? "on" : ""}"></i>`).join("")}<span>${labels[s]}</span></div>`;
  }

  // Vue grille : la fiche s'ouvre dans une fenêtre par-dessus.
  function openDetail(a) {
    if (!a) return;
    const m = PP.modal.open(`<div class="detail in-modal"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="dm-close">Fermer</button></div>`, { cls: "wide" });
    m.querySelector("#dm-close").addEventListener("click", () => PP.modal.close());
    const box = m.querySelector(".detail");
    // redessine seulement le contenu de la fenêtre (sans la fermer / rouvrir)
    const redraw = () => {
      const fresh = accounts.find((x) => x.id === a.id);
      if (fresh && document.body.contains(box)) fillDetail(box, fresh, redraw);
    };
    fillDetail(box, a, redraw);
  }

  function renderDetail() {
    const d = document.getElementById("detail");
    if (!d) return;
    const a = accounts.find((x) => x.id === S.selectedId);
    if (selecting) {
      d.innerHTML = `<div class="empty" style="height:100%;justify-content:center"><div class="big">☑️</div>Coche les comptes dans la liste, puis choisis une action en bas.</div>`;
      return;
    }
    if (!a) {
      d.innerHTML = `<div class="empty" style="height:100%;justify-content:center"><div class="big">🗝️</div>Sélectionne un compte ou crée-en un nouveau.</div>`;
      return;
    }
    fillDetail(d, a, renderDetail);
  }

  function fillDetail(d, a, redraw) {
    const profs = S.profiles.filter((p) => a.profiles.includes(p.id));
    const login = PP.applyMask(a.login, a.login_mask);
    const pw = revealed ? PP.applyMask(a.password, a.password_mask) : "•".repeat(Math.min(14, Math.max(8, a.password.length)));
    d.innerHTML = `
      <div class="detail-head">
        ${PP.logo(a, "xl")}
        <div style="min-width:0"><h2 class="selectable">${PP.esc(a.name)}</h2>
          <div class="row"><span class="chip">${PP.icon.tag.replace("<svg", '<svg style="width:12px"')}${PP.esc(a.category || "Sans catégorie")}</span>
          ${profs.map((p) => `<span class="chip" style="background:rgba(0,229,255,.1);border-color:rgba(0,229,255,.35);color:#bff8ff">${PP.esc(p.name)}</span>`).join("")}</div>
        </div>
        <div class="acts">
          <button class="icon-btn ${a.favorite ? "on" : ""}" id="fav" title="${a.favorite ? "Retirer des favoris" : "Ajouter aux favoris"}">${a.favorite ? PP.icon.starFill : PP.icon.star}</button>
          <button class="icon-btn" id="del" title="Supprimer">${PP.icon.trash}</button>
          <button class="btn btn-primary" id="edit">${PP.icon.edit} Modifier</button>
        </div>
      </div>
      <div class="fields">
        <div class="fld"><div class="v"><span class="label">Identifiant</span><div class="val selectable">${PP.esc(login) || '<span style="color:var(--faint)">—</span>'}</div></div>
          ${a.login ? `<button class="icon-btn" id="cl" title="Copier l'identifiant (sans espaces)">${PP.icon.copy}</button>` : ""}</div>
        <div class="fld"><div class="v"><span class="label">Mot de passe</span><div class="val ${revealed ? "selectable" : "masked"}">${PP.esc(pw)}</div>${strengthHtml(a.password)}</div>
          <button class="icon-btn" id="eye" title="${revealed ? "Masquer" : "Afficher"}">${revealed ? PP.icon.eyeOff : PP.icon.eye}</button>
          <button class="icon-btn" id="cp" title="Copier le mot de passe">${PP.icon.copy}</button></div>
      </div>
      <div class="meta"><span>Créé le ${new Date(a.created).toLocaleDateString("fr-FR")}</span><span>Modifié le ${new Date(a.updated).toLocaleDateString("fr-FR")}</span></div>`;
    d.querySelector("#eye").addEventListener("click", () => { revealed = !revealed; redraw(); });
    d.querySelector("#cp").addEventListener("click", () => PP.copySecret(a.password));
    const cl = d.querySelector("#cl");
    if (cl) cl.addEventListener("click", () => PP.copyPlain(a.login));
    d.querySelector("#edit").addEventListener("click", () => PP.views.form.openAccount(a));
    const inModal = d.classList.contains("in-modal");
    d.querySelector("#fav").addEventListener("click", async () => {
      await PP.call("save_account", { ...a, favorite: !a.favorite });
      await V.afterChange(false);
      if (inModal) redraw(); // la fenêtre reste ouverte avec l'étoile à jour
    });
    d.querySelector("#del").addEventListener("click", async () => {
      if (!(await PP.confirm(`Supprimer « ${a.name} » ?`, "Ce compte sera définitivement supprimé (une sauvegarde automatique reste disponible dans les réglages).", { ok: "Supprimer", danger: true }))) return;
      await PP.call("delete_account", a.id);
      S.selectedId = null;
      PP.toast("Compte supprimé");
      await V.afterChange();
    });
  }

  // Après une modification : recharge les données et redessine en gardant la position.
  V.afterChange = async (resetSelection = true) => {
    await V.reload();
    if (resetSelection) { selecting = false; checked.clear(); }
    renderLayout();
  };

  V.select = (id) => { S.selectedId = id; revealed = false; };

  V.focusSearch = (selectAll = true) => {
    const q = document.getElementById("q");
    if (!q) return;
    q.focus();
    if (selectAll) q.select(); else q.setSelectionRange(q.value.length, q.value.length);
  };

  V.newItem = () => {
    if (S.view === "giftcards") return PP.views.giftcards.openForm(null);
    const preset = S.filter.startsWith("cat:") ? S.filter.slice(4) : "";
    PP.views.form.openAccount(null, preset);
  };

  V.categories = () => categories().map(([c]) => c);
})();
