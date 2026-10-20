/* Choix du profil (« Qui est-ce ? »), accueil du premier lancement, édition d'un profil. */
(function () {
  const V = (PP.views.profiles = {});

  V.show = () => {
    const ps = PP.state.profiles;
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand()}
        <h1>Qui est-ce ?</h1>
        <div class="profiles">
          ${ps.map((p) => `
            <div class="profile-tile" data-p="${PP.esc(p.id)}">
              ${avatarBig(p)}<span>${PP.esc(p.name)}</span>
            </div>`).join("")}
          ${ps.length > 1 ? `<div class="profile-tile" data-p="*"><div class="av all">${PP.icon.users.replace("<svg", '<svg style="width:56px;height:56px"')}</div><span>Tout le monde</span></div>` : ""}
          <div class="profile-tile" data-add><div class="av add">+</div><span>Ajouter</span></div>
        </div>
      </div>`);
    app.querySelectorAll("[data-p]").forEach((t) =>
      t.addEventListener("click", () => PP.chooseProfile(t.dataset.p === "*" ? null : t.dataset.p))
    );
    app.querySelector("[data-add]").addEventListener("click", async () => {
      const p = await V.edit(null);
      if (p) { await PP.refreshState(); V.show(); }
    });
  };

  function avatarBig(p) {
    if (p.avatar) return `<div class="av"><img src="${PP.esc(p.avatar)}" alt=""></div>`;
    const c = PP.safeColor(p.color, p.name);
    return `<div class="av" style="background:linear-gradient(135deg,${c},${PP.shade(c)})">${PP.esc(PP.initial(p.name))}</div>`;
  }

  // Ouvre l'éditeur de profil ; renvoie le profil enregistré ou null.
  V.edit = (profile) =>
    new Promise((resolve) => {
      const p = profile ? { ...profile } : { id: null, name: "", avatar: null, color: PP.PALETTE[PP.state.profiles.length % PP.PALETTE.length] };
      let saved = null;
      const m = PP.modal.open(`
        <h2>${profile ? "Modifier le profil" : "Nouveau profil"}</h2>
        <div style="display:flex;gap:18px;align-items:center">
          <div id="pav"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:12px">
            <div class="field"><label>Nom</label><input class="input" id="pname" value="${PP.esc(p.name)}" placeholder="Ex. Jules"></div>
            <div class="field"><label>Couleur</label><div class="swatches" id="sw"></div></div>
            <div class="row"><button class="btn btn-ghost" id="pimg">${PP.icon.image} Image…</button>
              <button class="btn btn-ghost ${p.avatar ? "" : "hidden"}" id="pnoimg">Retirer l'image</button></div>
          </div>
        </div>
        <div class="err" id="perr"></div>
        <div class="modal-foot"><button class="btn btn-ghost" id="pcancel">Annuler</button><button class="btn btn-primary" id="psave">Enregistrer</button></div>`,
        { cls: "sm", onClose: () => resolve(saved) });
      const draw = () => {
        m.querySelector("#pav").innerHTML = PP.avatar({ ...p, name: m.querySelector("#pname").value || "?" }, "xl");
        m.querySelector("#sw").innerHTML = PP.PALETTE.map((c) => `<i data-c="${c}" class="${c === p.color ? "on" : ""}" style="background:${c}"></i>`).join("");
        m.querySelectorAll("#sw i").forEach((i) => i.addEventListener("click", () => { p.color = i.dataset.c; draw(); }));
        m.querySelector("#pnoimg").classList.toggle("hidden", !p.avatar);
      };
      draw();
      m.querySelector("#pname").addEventListener("input", draw);
      m.querySelector("#pname").focus();
      m.querySelector("#pimg").addEventListener("click", async () => {
        const img = await PP.call("pick_image");
        if (img) { p.avatar = img; draw(); }
      });
      m.querySelector("#pnoimg").addEventListener("click", () => { p.avatar = null; draw(); });
      m.querySelector("#pcancel").addEventListener("click", () => PP.modal.close());
      m.querySelector("#psave").addEventListener("click", async () => {
        p.name = m.querySelector("#pname").value.trim();
        if (!p.name) { m.querySelector("#perr").textContent = "Donne un nom au profil."; return; }
        saved = await PP.call("save_profile", p);
        PP.modal.close();
      });
    });

  // Premier lancement : prénom du premier profil et choix du verrou. L'import Excel est dans les réglages.
  V.welcome = () => {
    let mode = "pin";
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:560px;padding:28px;display:flex;flex-direction:column;gap:18px">
          <div><h2 style="margin:0 0 6px">Bienvenue !</h2>
            <div style="color:var(--muted)">Crée ton coffre : ton prénom pour le premier profil, puis la façon de le protéger.</div></div>
          <div class="field"><label>Ton prénom (premier profil)</label><input class="input" id="wname" placeholder="Ex. Jules"></div>
          <div class="field"><label>Protection</label>
            <div class="seg" id="wmode">
              <button data-m="pin" class="on">Code PIN</button><button data-m="password">Mot de passe</button><button data-m="none">Aucune</button>
            </div></div>
          <div id="wlock"></div>
          <div class="err" id="werr"></div>
          <div class="row" style="justify-content:space-between">
            <span class="hint">Tu pourras ensuite importer tes mots de passe Chrome ou un fichier Excel.</span>
            <button class="btn btn-primary" id="wgo">Créer mon coffre</button>
          </div>
        </div>
      </div>`);
    const $ = (s) => app.querySelector(s);
    const drawLock = () => {
      app.querySelectorAll("#wmode [data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
      if (mode === "none") {
        $("#wlock").innerHTML = `<div class="warn-box">Sans protection, tes données seront enregistrées en clair sur ce PC.
          Tu pourras ajouter un verrou plus tard dans les Réglages.</div>`;
        return;
      }
      const isPin = mode === "pin";
      const attrs = isPin ? 'inputmode="numeric" maxlength="12"' : "";
      $("#wlock").innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field"><label>${isPin ? "Code PIN (6 chiffres conseillés)" : "Mot de passe"}</label><input class="input" id="wc1" type="password" ${attrs}></div>
          <div class="field"><label>Confirmer</label><input class="input" id="wc2" type="password" ${attrs}></div>
        </div>
        <div class="hint" style="margin-top:8px">Toutes tes données seront chiffrées avec ce code. <b>S'il est oublié, elles ne pourront pas être récupérées.</b></div>`;
    };
    app.querySelectorAll("#wmode [data-m]").forEach((b) => b.addEventListener("click", () => { mode = b.dataset.m; drawLock(); }));
    drawLock();
    $("#wname").focus();
    $("#wgo").addEventListener("click", async () => {
      const err = $("#werr");
      const name = $("#wname").value.trim();
      if (!name) { err.textContent = "Indique un prénom pour ton profil."; return; }
      let code = null;
      if (mode !== "none") {
        const a = $("#wc1").value, b = $("#wc2").value;
        if (mode === "pin" && !/^[0-9]{4,12}$/.test(a)) { err.textContent = "Le PIN doit contenir de 4 à 12 chiffres."; return; }
        if (mode === "password" && a.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères."; return; }
        if (a !== b) { err.textContent = "Les deux saisies ne correspondent pas."; return; }
        code = a;
      }
      $("#wgo").disabled = true;
      try {
        await PP.call("start_empty", name);
        if (code) await PP.call("set_lock", mode, code);
      } finally {
        $("#wgo").disabled = false;
      }
      await PP.route();
      PP.views.chrome.intro({ welcome: true });
    });
  };
})();
