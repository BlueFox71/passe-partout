/* Import des mots de passe de Chrome : explication de l'export, puis revue ligne par ligne avant l'import. */
(function () {
  const V = (PP.views.chrome = {});
  const S = PP.state;
  const CHROME_URL = "chrome://password-manager/settings";

  // Fenêtre d'explication : comment exporter depuis Chrome, puis choix du fichier.
  V.intro = ({ welcome = false } = {}) => {
    const m = PP.modal.open(`
      <h2>${welcome ? "Tu utilises Chrome ?" : "Importer depuis Chrome"}</h2>
      <p style="color:var(--muted);margin:0 0 14px">${welcome ? "Récupère tes mots de passe enregistrés dans Chrome en quelques clics." : "Ajoute les mots de passe enregistrés dans Chrome."}</p>
      <ol class="chrome-steps">
        <li>Ouvre ce lien dans Chrome (copie-le dans la barre d'adresse) :
          <div class="row chrome-link"><code>${CHROME_URL}</code>
            <button class="btn btn-ghost" id="ch-copy" style="padding:6px 12px">${PP.icon.copy} Copier le lien</button></div></li>
        <li>Clique sur <b>Exporter les mots de passe</b>, puis valide avec ton code Windows.</li>
        <li>Choisis ici le fichier <b>Mots de passe Chrome.csv</b> téléchargé.</li>
      </ol>
      <div class="modal-foot"><button class="btn btn-ghost" id="ch-later">${welcome ? "Plus tard" : "Annuler"}</button>
        <button class="btn btn-primary" id="ch-pick">Choisir le fichier CSV…</button></div>`, { cls: "sm" });
    m.querySelector("#ch-copy").addEventListener("click", () => PP.copyPlain(CHROME_URL, "Lien"));
    m.querySelector("#ch-later").addEventListener("click", () => PP.modal.close());
    m.querySelector("#ch-pick").addEventListener("click", start);
  };

  // « paypal » → « PayPal » quand la bibliothèque connaît la marque sous ce nom (même lettres, autre casse).
  const squash = (s) => PP.normalize(s).replace(/[^a-z0-9]/g, "");
  function brandName(name) {
    const e = PP.logos.find(name);
    return e && squash(e[0]) === squash(name) ? e[0] : name;
  }

  async function start() {
    const pre = await PP.call("preview_chrome_import", null);
    if (!pre) return; // sélection annulée
    if (!pre.rows.length) {
      PP.modal.close();
      PP.toast(pre.uptodate ? `Rien à importer : ${pre.uptodate} compte(s) déjà à jour` : "Aucun mot de passe dans ce fichier", { seconds: 5 });
      return askDelete();
    }
    const existing = await PP.call("list_accounts", null);
    const pid = (S.profiles.find((p) => p.id === S.profileId) || S.profiles[0]).id;
    const rows = pre.rows.map((r, i) => ({ key: i, name: brandName(r.name), category: "", login: r.login, password: r.password,
      profile: pid, replace: null, image: null, show: false }));
    rows.forEach((r) => { r.replace = defaultReplace(r, existing); });
    review(rows, existing, pre.uptodate);
  }

  // Même nom aux espaces, accents et ponctuation près : « Le Bon Coin » = « leboncoin ».
  const matchesOf = (r, existing) => existing.filter((a) => squash(a.name) === squash(r.name));
  // Un compte existant du même nom et du même identifiant : on propose d'en remplacer le mot de passe.
  function defaultReplace(r, existing) {
    const same = matchesOf(r, existing).find((a) => PP.normalize(a.login) === PP.normalize(r.login));
    return same ? same.id : null;
  }

  function review(rows, existing, uptodate) {
    const profName = (id) => (S.profiles.find((p) => p.id === id) || {}).name || "?";
    const profOptions = (sel) => S.profiles.map((p) => `<option value="${PP.esc(p.id)}" ${p.id === sel ? "selected" : ""}>${PP.esc(p.name)}</option>`).join("");
    const m = PP.modal.open(`
      <h2>Importer depuis Chrome</h2>
      <div class="row chrome-head">
        <div class="field" style="margin:0"><label>Profil de destination (toutes les lignes)</label>
          <select class="input" id="ch-all">${profOptions(rows[0].profile)}</select></div>
        <div class="row" style="gap:10px"><div class="hint" id="ch-count"></div>
          <button class="btn btn-ghost" id="ch-dropsame" style="padding:6px 12px" hidden></button></div>
      </div>
      <div class="chrome-fields chrome-cols"><span></span><span>Nom</span><span>Catégorie</span><span>Identifiant</span><span>Mot de passe</span><span>Profil</span></div>
      <div class="chrome-rows" id="ch-rows"></div>
      <div class="modal-foot"><button class="btn btn-ghost" id="ch-cancel">Annuler</button>
        <button class="btn btn-primary" id="ch-go"></button></div>`, { cls: "xwide" });
    const $ = (s) => m.querySelector(s);
    const list = $("#ch-rows");

    const label = (a) => `${a.name}${a.login ? ` — ${a.login}` : ""} (${a.profiles.map(profName).join(", ")})`;
    // Image choisie (cliquable pour la retirer), sinon le logo de la marque qui sera posé automatiquement.
    const thumb = (r) => {
      if (r.image) return `<button type="button" class="chrome-thumb" data-img-del title="Retirer l'image">${PP.logo({ name: r.name, image: r.image })}</button>`;
      const e = PP.logos.brandOf(r.name);
      return `<span class="chrome-thumb auto" title="${e ? "Logo ajouté automatiquement" : "Pas d'image"}">${PP.logo({ name: r.name, image: e ? PP.logos.image(e) : null })}</span>`;
    };
    // Mot de passe actuel du compte visé (ou du premier homonyme quand on crée), masqué par défaut.
    const oldPassword = (r, matches) => {
      const a = matches.find((x) => x.id === r.replace) || matches[0];
      const shown = r.showOld ? PP.esc(a.password) || "<i>vide</i>" : "•".repeat(Math.min(12, Math.max(6, a.password.length)));
      return `<span class="chrome-old">Actuel : <code>${shown}</code>
        <button type="button" class="icon-btn" data-eye-old title="Afficher le mot de passe actuel">${r.showOld ? PP.icon.eyeOff : PP.icon.eye}</button></span>`;
    };
    const rowHtml = (r) => {
      const matches = matchesOf(r, existing);
      const twins = rows.filter((x) => x !== r && squash(x.name) === squash(r.name));
      const rep = !!r.replace;
      const same = sameOf(r, matches);
      return `<div class="chrome-row${same ? " same-pw" : matches.length || twins.length ? " dup" : ""}" data-k="${r.key}">
        <div class="chrome-fields">
          ${thumb(r)}
          <input class="input" data-f="name" value="${PP.esc(r.name)}" placeholder="Nom" title="Nom">
          ${PP.catPicker.html(r.category, `data-cat title="Catégorie" ${rep ? "disabled" : ""}`)}
          <input class="input" data-f="login" value="${PP.esc(r.login)}" placeholder="Identifiant" title="Identifiant" ${rep ? "disabled" : ""}>
          <div class="pw-wrap"><input class="input" data-f="password" type="${r.show ? "text" : "password"}" value="${PP.esc(r.password)}" placeholder="Mot de passe" title="Mot de passe">
            <button type="button" class="icon-btn" data-eye title="Afficher">${r.show ? PP.icon.eyeOff : PP.icon.eye}</button></div>
          <select class="input" data-f="profile" title="Profil" ${rep ? "disabled" : ""}>${profOptions(r.profile)}</select>
          <button class="icon-btn" data-img-pick title="Choisir une image…">${PP.icon.image}</button>
          <button class="icon-btn" data-img-paste title="Coller l'image du presse-papiers">${PP.icon.paste}</button>
          <button class="icon-btn" data-del title="Retirer de l'import">${PP.icon.trash}</button>
        </div>
        ${same ? `<div class="chrome-warn same">⚠ Mot de passe identique à ${PP.esc(label(same))} : cette ligne n'apporte rien.
          <button class="btn btn-ghost" data-del>${PP.icon.trash} Retirer la ligne</button></div>` : ""}
        ${matches.length ? `<div class="chrome-warn">⚠ Déjà présent dans Passe-Partout :
          <select class="input" data-f="replace">
            <option value="">Créer un nouveau compte</option>
            ${matches.map((a) => `<option value="${PP.esc(a.id)}" ${a.id === r.replace ? "selected" : ""}>Remplacer le mot de passe de ${PP.esc(label(a))}</option>`).join("")}
          </select>
          ${oldPassword(r, matches)}</div>` : ""}
        ${twins.length ? `<div class="chrome-warn">⚠ ${twins.length + 1} lignes « ${PP.esc(r.name)} » dans cet import</div>` : ""}
      </div>`;
    };
    // Compte existant du même nom avec exactement ce mot de passe : la ligne est à retirer en priorité.
    const sameOf = (r, matches = matchesOf(r, existing)) => matches.find((a) => a.password === r.password) || null;
    const counts = () => {
      const nSame = rows.filter((r) => sameOf(r)).length;
      $("#ch-dropsame").hidden = !nSame;
      $("#ch-dropsame").textContent = `Retirer ${nSame} ligne(s) au mot de passe identique`;
      const upd = rows.filter((r) => r.replace).length;
      const add = rows.length - upd;
      $("#ch-count").textContent = `${rows.length} compte(s)${uptodate ? ` · ${uptodate} déjà à jour, non affiché(s)` : ""}`;
      $("#ch-go").textContent = [add && `Importer ${add} compte(s)`, upd && `mettre à jour ${upd} mot(s) de passe`].filter(Boolean).join(" et ") || "Importer";
      $("#ch-go").disabled = !rows.length;
    };
    // Redessine la liste en gardant le champ en cours de saisie (et la position de défilement).
    const draw = () => {
      const a = document.activeElement;
      const focus = a && list.contains(a) && a.dataset.f ? [a.closest("[data-k]").dataset.k, a.dataset.f, a.selectionStart] : null;
      const top = list.scrollTop;
      list.innerHTML = rows.map(rowHtml).join("");
      list.scrollTop = top;
      if (focus) {
        const inp = list.querySelector(`[data-k="${focus[0]}"] [data-f="${focus[1]}"]`);
        if (inp) { inp.focus(); if (focus[2] != null && inp.setSelectionRange) inp.setSelectionRange(focus[2], focus[2]); }
      }
      counts();
    };
    const rowOf = (el) => rows.find((r) => r.key === Number(el.closest("[data-k]").dataset.k));

    let pending = null;
    list.addEventListener("input", (e) => {
      const f = e.target.dataset.f;
      if (!["name", "login", "password"].includes(f)) return;
      const r = rowOf(e.target);
      r[f] = e.target.value;
      if (f !== "name") return;
      // le nom change les doublons : alertes recalculées une fois la saisie posée
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (!matchesOf(r, existing).some((a) => a.id === r.replace)) r.replace = defaultReplace(r, existing);
        draw();
      }, 400);
    });
    list.addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      const r = f && rowOf(e.target);
      if (f === "profile") r.profile = e.target.value;
      if (f === "replace") { r.replace = e.target.value || null; draw(); }
    });
    list.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-eye],[data-eye-old],[data-del],[data-img-pick],[data-img-paste],[data-img-del],[data-cat]");
      if (!b) return;
      const r = rowOf(b);
      if (b.hasAttribute("data-cat")) {
        const cats = [...existing.map((a) => a.category), ...rows.map((x) => x.category)];
        PP.catPicker.open(b, r.category, cats, (c) => { r.category = c; draw(); });
        return;
      }
      if (b.hasAttribute("data-img-del")) { r.image = null; draw(); return; }
      if (b.hasAttribute("data-img-pick") || b.hasAttribute("data-img-paste")) {
        const paste = b.hasAttribute("data-img-paste");
        const img = await PP.call(paste ? "paste_image" : "pick_image");
        if (img) { r.image = img; draw(); } else if (paste) PP.toast("Aucune image dans le presse-papiers", { error: true });
        return;
      }
      if (b.hasAttribute("data-eye-old")) { r.showOld = !r.showOld; draw(); return; }
      if (b.hasAttribute("data-eye")) { r.show = !r.show; draw(); return; }
      rows.splice(rows.indexOf(r), 1);
      draw();
    });
    $("#ch-all").addEventListener("change", () => {
      rows.forEach((r) => { r.profile = $("#ch-all").value; });
      draw();
    });
    $("#ch-dropsame").addEventListener("click", () => {
      for (const r of rows.filter((x) => sameOf(x))) rows.splice(rows.indexOf(r), 1);
      draw();
    });
    $("#ch-cancel").addEventListener("click", () => PP.modal.close());
    $("#ch-go").addEventListener("click", async () => {
      if (rows.some((r) => !r.name.trim())) { PP.toast("Chaque compte doit avoir un nom", { error: true }); return; }
      $("#ch-go").disabled = true;
      let res;
      try {
        res = await PP.call("import_chrome", rows.map((r) => ({ name: r.name, category: r.category, login: r.login,
          password: r.password, profile: r.profile, replace: r.replace, image: r.image })));
      } finally { $("#ch-go").disabled = false; }
      PP.modal.close();
      const logos = await PP.views.settings.applyMissingLogos();
      PP.toast([`${res.added} compte(s) ajouté(s)`, res.updated && `${res.updated} mot(s) de passe mis à jour`,
        logos && `${logos} logo(s) ajouté(s)`].filter(Boolean).join(", "), { seconds: 6 });
      await PP.views.main.afterChange();
      await askDelete();
    });
    draw();
  }

  async function askDelete() {
    const ok = await PP.confirm("Supprimer le fichier exporté ?",
      "Le fichier de Chrome contient tous tes mots de passe en clair. Maintenant qu'ils sont dans Passe-Partout, mieux vaut le supprimer.",
      { ok: "Supprimer le fichier", cancel: "Passer", danger: true });
    if (ok && (await PP.call("delete_chrome_csv"))) PP.toast("Fichier supprimé");
  }
})();
