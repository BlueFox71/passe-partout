/* Formulaire de création / modification d'un compte, avec image (fichier, Ctrl+V, glisser-déposer). */
(function () {
  const V = (PP.views.form = {});
  const S = PP.state;

  // Zone image réutilisable (comptes, cartes cadeaux). `get`/`set` lisent et écrivent l'image courante.
  V.imageZone = (container, get, set, nameFn) => {
    const draw = () => {
      container.innerHTML = `
        <div class="drop" tabindex="0" id="drop">
          ${PP.logo({ name: nameFn() || "?", image: get() }, "")}
          <div class="txt"><b style="color:var(--text)">Image</b><br>Colle une image avec <b>Ctrl+V</b>, glisse un fichier ici, ou choisis un fichier.</div>
          <button type="button" class="btn btn-ghost" id="imgpick">${PP.icon.image} Fichier…</button>
          ${get() ? `<button type="button" class="icon-btn" id="imgdel" title="Retirer l'image">${PP.icon.trash}</button>` : ""}
        </div>`;
      container.querySelector("#imgpick").addEventListener("click", async () => {
        const img = await PP.call("pick_image");
        if (img) { set(img); draw(); }
      });
      const del = container.querySelector("#imgdel");
      if (del) del.addEventListener("click", () => { set(null); draw(); });
      const drop = container.querySelector("#drop");
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
        if (f) readFile(f);
        else PP.toast("Ce n'est pas une image", { error: true });
      });
    };
    const readFile = (file) => {
      const r = new FileReader();
      r.onload = async () => {
        try { set(await PP.call("normalize_image", r.result)); draw(); } catch (_) { /* toast déjà affiché */ }
      };
      r.readAsDataURL(file);
    };
    const onPaste = (e) => {
      if (!document.body.contains(container)) return document.removeEventListener("paste", onPaste);
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) return; // collage de texte normal dans un champ
      e.preventDefault();
      readFile(item.getAsFile());
      PP.toast("Image collée");
    };
    document.addEventListener("paste", onPaste);
    draw();
    return { redraw: draw };
  };

  V.profileChecks = (container, selected) => {
    const draw = () => {
      container.innerHTML = S.profiles.map((p) => `<div class="check ${selected.has(p.id) ? "on" : ""}" data-p="${p.id}">${PP.avatar(p)}${PP.esc(p.name)}</div>`).join("");
      container.querySelectorAll("[data-p]").forEach((c) => c.addEventListener("click", () => {
        const id = c.dataset.p;
        selected.has(id) ? selected.delete(id) : selected.add(id);
        draw();
      }));
    };
    draw();
  };

  V.defaultProfiles = () => new Set([S.profileId ?? S.profiles[0].id]);

  V.openAccount = (account, presetCategory = "") => {
    const a = account
      ? { ...account }
      : { id: null, name: "", category: presetCategory, login: "", password: "", login_mask: null, password_mask: null, image: null, favorite: false, profiles: [] };
    const profs = account ? new Set(a.profiles) : V.defaultProfiles();
    const cats = PP.views.main.categories();
    let showPw = !account;

    const m = PP.modal.open(`
      <h2>${account ? "Modifier le compte" : "Nouveau compte"}</h2>
      <div class="grid2">
        <div class="field"><label>Nom</label><input class="input" id="f-name" value="${PP.esc(a.name)}" placeholder="Ex. Boursorama"></div>
        <div class="field"><label>Catégorie</label><input class="input" id="f-cat" list="f-cats" value="${PP.esc(a.category)}" placeholder="Ex. Banque">
          <datalist id="f-cats">${cats.map((c) => `<option value="${PP.esc(c)}">`).join("")}</datalist></div>
        <div class="field"><label>Identifiant</label><input class="input" id="f-login" value="${PP.esc(a.login)}" placeholder="Adresse mail, numéro…" spellcheck="false"></div>
        <div class="field"><label>Format de l'identifiant <span style="text-transform:none;letter-spacing:0">(facultatif)</span></label>
          <input class="input" id="f-lmask" value="${PP.esc(a.login_mask || "")}" placeholder="Ex. ## ## ### ### ###" spellcheck="false">
          <div class="preview-mask" id="f-lprev"></div></div>
        <div class="field"><label>Mot de passe</label><div class="pw-wrap">
          <input class="input" id="f-pw" type="${showPw ? "text" : "password"}" value="${PP.esc(a.password)}" spellcheck="false">
          <button type="button" class="icon-btn" id="f-eye">${showPw ? PP.icon.eyeOff : PP.icon.eye}</button></div>
          <div id="f-str"></div></div>
        <div class="field"><label>Format du mot de passe <span style="text-transform:none;letter-spacing:0">(facultatif)</span></label>
          <input class="input" id="f-pmask" value="${PP.esc(a.password_mask || "")}" placeholder="Ex. #### ####" spellcheck="false">
          <div class="preview-mask" id="f-pprev"></div></div>
        <div class="full" id="f-img"></div>
        <div class="field full"><label>Profils</label><div class="checks" id="f-profs"></div></div>
        <div class="full"><label class="toggle ${a.favorite ? "on" : ""}" id="f-fav"><i></i>Favori</label></div>
      </div>
      <div class="hint" style="margin-top:12px">Format : chaque <b>#</b> remplace un caractère, le reste est ajouté tel quel. La copie se fait toujours sans les espaces ajoutés.</div>
      <div class="err" id="f-err"></div>
      <div class="modal-foot">
        <button class="btn btn-ghost" id="f-cancel">Annuler</button>
        <button class="btn btn-primary" id="f-save">${PP.icon.check} Enregistrer</button>
      </div>`);

    const $ = (id) => m.querySelector(id);
    const preview = () => {
      const lv = $("#f-login").value, lm = $("#f-lmask").value;
      $("#f-lprev").textContent = lm && lv ? "Aperçu : " + PP.applyMask(lv, lm) : "";
      const pv = $("#f-pw").value, pm = $("#f-pmask").value;
      $("#f-pprev").textContent = pm && pv ? "Aperçu : " + (showPw ? PP.applyMask(pv, pm) : PP.applyMask("•".repeat(pv.length), pm)) : "";
      const s = PP.strength(pv);
      const colors = ["#ff4d6d", "#ff4d6d", "#ffc23d", "#00e5ff", "#3dffb0"];
      const labels = ["Très faible", "Faible", "Moyen", "Solide", "Très solide"];
      $("#f-str").innerHTML = pv ? `<div class="strength" style="--c:${colors[s]}">${[1, 2, 3, 4].map((i) => `<i class="${i <= s ? "on" : ""}"></i>`).join("")}<span>${labels[s]}</span></div>` : "";
    };
    ["#f-login", "#f-lmask", "#f-pw", "#f-pmask"].forEach((id) => $(id).addEventListener("input", preview));
    preview();

    $("#f-eye").addEventListener("click", () => {
      showPw = !showPw;
      $("#f-pw").type = showPw ? "text" : "password";
      $("#f-eye").innerHTML = showPw ? PP.icon.eyeOff : PP.icon.eye;
      preview();
    });
    const zone = V.imageZone($("#f-img"), () => a.image, (v) => (a.image = v), () => $("#f-name").value);
    $("#f-name").addEventListener("input", () => { if (!a.image) zone.redraw(); });
    V.profileChecks($("#f-profs"), profs);
    $("#f-fav").addEventListener("click", (e) => { e.preventDefault(); a.favorite = !a.favorite; $("#f-fav").classList.toggle("on", a.favorite); });
    $("#f-cancel").addEventListener("click", () => PP.modal.close());
    $("#f-name").focus();

    const save = async () => {
      const rec = {
        ...a,
        name: $("#f-name").value.trim(),
        category: $("#f-cat").value.trim(),
        login: $("#f-login").value.trim(),
        password: $("#f-pw").value,
        login_mask: $("#f-lmask").value.trim() || null,
        password_mask: $("#f-pmask").value.trim() || null,
        profiles: [...profs],
      };
      if (!rec.name) { $("#f-err").textContent = "Le nom est obligatoire."; return; }
      if (!rec.profiles.length) { $("#f-err").textContent = "Choisis au moins un profil."; return; }
      const saved = await PP.call("save_account", rec);
      PP.modal.close();
      PP.toast(account ? "Compte modifié" : "Compte ajouté");
      if (!account && PP.state.profileId && !saved.profiles.includes(PP.state.profileId)) {
        PP.toast("Ce compte n'appartient pas au profil affiché");
      }
      PP.views.main.select(saved.id);
      await PP.views.main.afterChange();
    };
    $("#f-save").addEventListener("click", save);
    m.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) save(); });
  };
})();
