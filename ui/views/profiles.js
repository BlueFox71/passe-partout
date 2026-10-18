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
            <div class="profile-tile" data-p="${p.id}">
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
    const c = p.color || PP.colorFor(p.name);
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

  V.welcome = () => {
    let mode = "import";
    const app = PP.render(`
      <div class="screen-center">
        ${PP.brand("big-brand")}
        <div class="glass" style="width:560px;padding:28px;display:flex;flex-direction:column;gap:18px">
          <div><h2 style="margin:0 0 6px">Bienvenue !</h2>
            <div style="color:var(--muted)">Pour commencer, tu peux reprendre ton fichier Excel de mots de passe ou partir de zéro.</div></div>
          <div class="choice-cards">
            <div class="choice-card on" data-m="import"><div class="ic">📥</div><b>Importer mon Excel</b><small>Reprend tous les comptes de ton fichier .xlsx</small></div>
            <div class="choice-card" data-m="empty"><div class="ic">✨</div><b>Partir de zéro</b><small>Un coffre vide, tu ajoutes tes comptes au fur et à mesure</small></div>
          </div>
          <div class="field"><label>Ton prénom (premier profil)</label><input class="input" id="wname" placeholder="Ex. Jules"></div>
          <div class="err" id="werr"></div>
          <div class="row" style="justify-content:flex-end"><button class="btn btn-primary" id="wgo">Continuer</button></div>
        </div>
      </div>`);
    app.querySelectorAll("[data-m]").forEach((c) =>
      c.addEventListener("click", () => {
        mode = c.dataset.m;
        app.querySelectorAll("[data-m]").forEach((x) => x.classList.toggle("on", x === c));
      })
    );
    app.querySelector("#wname").focus();
    app.querySelector("#wgo").addEventListener("click", async () => {
      const name = app.querySelector("#wname").value.trim();
      if (!name) { app.querySelector("#werr").textContent = "Indique un prénom pour ton profil."; return; }
      if (mode === "import") {
        const r = await PP.call("import_excel", null, name);
        if (!r) return; // sélection de fichier annulée
        PP.toast(`${r.added} comptes importés`, { seconds: 4 });
      } else {
        await PP.call("start_empty", name);
      }
      PP.route();
    });
  };
})();
