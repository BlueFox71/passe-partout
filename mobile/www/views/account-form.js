/* Téléphone — formulaire d'un compte (création, modification, suppression), plein écran.
   PP.views.accountForm.open(hôte, compte|null, {live, onSaved(enregistré), onDeleted(), onCancel()}) :
   `live()` est faux dès que l'hôte affiche autre chose (verrouillage, retour) ; les rappels ne sont
   alors plus appelés. Nom avec suggestions et logo de la bibliothèque (PP.logos) ; pas de photo ni de
   fichier sur le téléphone. Les formats (identifiant, mot de passe) venus du PC sont conservés. */
(function () {
  const F = (PP.views.accountForm = {});
  const S = PP.state;
  const esc = (s) => PP.esc(s);

  F.open = (host, account, { live, onSaved, onDeleted, onCancel }) => {
    const a = account
      ? { ...account }
      : { id: null, name: "", category: "", login: "", password: "", login_mask: null, password_mask: null,
          image: null, favorite: false, profiles: [] };
    const profs = new Set(account ? a.profiles || [] : PP.mui.defaultProfiles());
    let showPw = !account;
    let busy = false;

    host.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="f-cancel">${PP.icon.back}<span>Annuler</span></button>
        <div class="m-bar-title">${account ? "Modifier le compte" : "Nouveau compte"}</div>
      </div>
      <form class="m-sheet-body m-form" id="f-form" novalidate autocomplete="off">
        ${PP.mui.nameField(a.name, "Ex. Netflix, Impôts…")}
        <div class="field">
          <label for="f-cat">Catégorie</label>
          <input class="input m-in" id="f-cat" list="f-cats" value="${esc(a.category)}" placeholder="Ex. Banque"
            autocomplete="off" enterkeyhint="next"><datalist id="f-cats"></datalist>
        </div>
        <div class="field">
          <label for="f-login">Identifiant</label>
          <input class="input m-in" id="f-login" value="${esc(a.login)}" placeholder="Adresse mail, numéro…"
            autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="next">
        </div>
        <div class="field">
          <label for="f-pw">Mot de passe</label>
          <div class="m-pw-row">
            <input class="input m-in" id="f-pw" type="${showPw ? "text" : "password"}" value="${esc(a.password)}"
              autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
            <button type="button" class="m-ibtn" id="f-eye"></button>
          </div>
          <div id="f-str"></div>
        </div>
        <div class="field">
          <label>Profils</label>
          <div class="checks m-checks" id="f-profs"></div>
        </div>
        <button type="button" class="toggle m-toggle${a.favorite ? " on" : ""}" id="f-fav" aria-pressed="${!!a.favorite}"><i></i>Favori</button>
        <div class="err" id="f-err" role="alert"></div>
        <button type="submit" class="btn btn-primary m-wide" id="f-save">${PP.icon.check}Enregistrer</button>
        ${account ? `<button type="button" class="btn btn-danger m-wide" id="f-del">${PP.icon.trash}Supprimer le compte</button>` : ""}
      </form>`;

    const $ = (sel) => host.querySelector(sel);
    const { input: name, closeSug } = PP.mui.bindNameField(host, a, "#f-cat");
    const pw = $("#f-pw");
    const err = $("#f-err");

    // ---------------------------------------------------------- catégories existantes (tous profils)
    PP.call("list_accounts", null).then((all) => {
      if (!live()) return;
      const seen = new Map();
      for (const x of all) {
        const c = String(x.category || "").trim();
        if (c && !seen.has(PP.normalize(c))) seen.set(PP.normalize(c), c);
      }
      const cats = [...seen.values()].sort((x, y) => x.localeCompare(y, "fr", { sensitivity: "base" }));
      $("#f-cats").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");
    }).catch(() => {});

    // ---------------------------------------------------------- mot de passe
    const drawPw = () => {
      pw.type = showPw ? "text" : "password";
      const eye = $("#f-eye");
      eye.innerHTML = showPw ? PP.icon.eyeOff : PP.icon.eye;
      eye.setAttribute("aria-label", showPw ? "Masquer le mot de passe" : "Afficher le mot de passe");
      $("#f-str").innerHTML = pw.value ? PP.views.accounts.strengthHtml(pw.value) : "";
    };
    $("#f-eye").addEventListener("click", () => { showPw = !showPw; drawPw(); });
    pw.addEventListener("input", drawPw);
    drawPw();

    // ---------------------------------------------------------- profils, favori
    PP.mui.profileChecks($("#f-profs"), profs);
    const fav = $("#f-fav");
    fav.addEventListener("click", () => {
      a.favorite = !a.favorite;
      fav.classList.toggle("on", a.favorite);
      fav.setAttribute("aria-pressed", String(a.favorite));
    });

    // ---------------------------------------------------------- actions
    const setBusy = (v) => {
      busy = v;
      host.querySelectorAll("#f-save, #f-del").forEach((b) => { b.disabled = v; });
    };

    $("#f-cancel").addEventListener("click", () => { if (!busy) onCancel(); });

    $("#f-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      closeSug();
      const rec = {
        ...a,
        name: name.value.trim(),
        category: $("#f-cat").value.trim(),
        login: $("#f-login").value.trim(),
        password: pw.value,
        profiles: [...profs],
      };
      delete rec.created; // horodatage posé par l'API locale
      delete rec.updated;
      if (!rec.name) { err.textContent = "Le nom est obligatoire."; name.focus(); return; }
      if (!rec.profiles.length) { err.textContent = "Choisis au moins un profil."; return; }
      err.textContent = "";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // ferme le clavier
      setBusy(true);
      let saved;
      try {
        saved = await PP.call("save_account", rec);
      } catch (ex) {
        if (live()) setBusy(false); // message déjà affiché par PP.call
        return;
      }
      if (live()) onSaved(saved);
    });

    const del = $("#f-del");
    if (del) {
      del.addEventListener("click", async () => {
        if (busy) return;
        const ok = await PP.confirm(`Supprimer « ${account.name} » ?`,
          "Ce compte sera supprimé de ce téléphone, puis du PC à la prochaine synchronisation.",
          { ok: "Supprimer", danger: true });
        if (!ok || !live()) return;
        setBusy(true);
        try {
          await PP.call("delete_account", account.id);
        } catch (ex) {
          if (live()) setBusy(false);
          return;
        }
        if (live()) onDeleted();
      });
    }

    if (!account) name.focus();
  };
})();
