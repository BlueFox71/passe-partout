/* Téléphone — morceaux d'interface communs aux onglets Comptes et Cartes (PP.mui) :
   puces de profil, fiche plein écran par-dessus la liste, cases de profils et champ « Nom » avec logo
   de la bibliothèque (PP.logos) dans les formulaires. */
(function () {
  const M = (PP.mui = {});
  const S = PP.state;
  const esc = (s) => PP.esc(s);
  const SUGGESTIONS = 5;

  // ------------------------------------------------------------ puces de profil (filtre de la liste)
  // Profil affiché oublié s'il n'existe plus, ou s'il n'y a qu'un profil (pas de puces).
  M.checkProfileFilter = () => {
    const profiles = S.profiles || [];
    if (S.profileId && (profiles.length < 2 || !profiles.some((p) => p.id === S.profileId))) S.profileId = null;
  };

  M.chip = (key, label, on, aria = "") =>
    `<button type="button" class="m-chip${on ? " on" : ""}" data-chip="${key}" aria-pressed="${on}"${aria}><span>${label}</span></button>`;

  // « Tout le monde » + une puce par profil, seulement à partir de 2 profils.
  M.profileChips = () => {
    const profiles = S.profiles || [];
    if (profiles.length < 2) return "";
    const pid = S.profileId ?? null;
    return M.chip("p:", "Tout le monde", pid === null) + profiles.map((p) => M.chip(`p:${esc(p.id)}`, esc(p.name), pid === p.id)).join("");
  };

  // Puce de profil touchée : vrai si le profil affiché a changé (la liste est alors à recharger).
  M.pickProfile = (key) => {
    if (!key.startsWith("p:")) return false;
    const id = key.slice(2) || null;
    if (id === (S.profileId ?? null)) return false;
    S.profileId = id;
    return true;
  };

  // ------------------------------------------------------------ fiche plein écran
  M.showSheet = (sh) => {
    sh.hidden = false;
    sh.scrollTop = 0;
    return sh;
  };

  M.hideSheet = (sh) => {
    sh.hidden = true;
    sh.innerHTML = "";
  };

  M.profileNames = (item) =>
    (S.profiles || []).filter((p) => (item.profiles || []).includes(p.id)).map((p) => p.name);

  // ------------------------------------------------------------ formulaires : profils
  // Profil coché par défaut : celui de la puce choisie, sinon le premier.
  M.defaultProfiles = () => {
    const profiles = S.profiles || [];
    if (S.profileId && profiles.some((p) => p.id === S.profileId)) return [S.profileId];
    return profiles.length ? [profiles[0].id] : [];
  };

  // Cases de profils (44 px) dans `el` ; `profs` (Set) est modifié en place.
  M.profileChecks = (el, profs) => {
    const draw = () => {
      el.innerHTML = (S.profiles || []).map((p) => {
        const on = profs.has(p.id);
        return `<button type="button" class="check m-pcheck${on ? " on" : ""}" data-p="${esc(p.id)}" aria-pressed="${on}">${PP.avatar(p)}${esc(p.name)}</button>`;
      }).join("");
    };
    el.addEventListener("click", (e) => {
      const c = e.target.closest("[data-p]");
      if (!c) return;
      const id = c.dataset.p;
      if (profs.has(id)) profs.delete(id);
      else profs.add(id);
      draw();
    });
    draw();
  };

  // ------------------------------------------------------------ formulaires : nom et logo
  M.nameField = (value, placeholder) => `
    <div class="field">
      <label for="f-name">Nom</label>
      <div class="m-name-row"><div id="f-logo"></div>
        <input class="input m-in" id="f-name" value="${esc(value)}" placeholder="${esc(placeholder)}"
          autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="next"></div>
      <div class="m-suggest" id="f-sug"></div>
      <div class="m-logo-line"><span class="logo-hint" id="f-hint"></span>
        <button type="button" class="m-link m-unlogo" id="f-unlogo" hidden>Retirer le logo</button></div>
    </div>`;

  // Suggestions de la bibliothèque et logo de `item` (item.image modifié en place). Le logo est posé quand
  // un nom connu est choisi ou tapé en entier, retiré si le nom change ensuite ; jamais par-dessus une
  // image venue du PC, sauf choix explicite dans la liste. `nextSel` : champ suivant après un choix.
  M.bindNameField = (host, item, nextSel) => {
    const $ = (sel) => host.querySelector(sel);
    const name = $("#f-name");
    let auto = false; // logo posé automatiquement depuis la bibliothèque

    const drawLogo = () => {
      $("#f-logo").innerHTML = PP.logo({ name: name.value.trim() || "?", image: item.image }, "m-flogo");
      $("#f-unlogo").hidden = !item.image;
    };
    const setHint = (t) => { $("#f-hint").textContent = t; };
    const libraryLogo = (entry) => {
      try {
        return PP.logos.render(entry);
      } catch (e) {
        return null; // dessin impossible : on garde l'initiale
      }
    };
    const onLogo = (entry, explicit) => {
      if (entry && (explicit || !item.image || auto)) {
        const img = libraryLogo(entry);
        if (img) {
          item.image = img;
          auto = true;
          setHint(`Logo « ${entry[0]} » ajouté.`);
        }
      } else if (!entry && auto) {
        item.image = null;
        auto = false;
        setHint("");
      }
      drawLogo();
    };

    const sug = $("#f-sug");
    let items = [];
    const closeSug = () => { items = []; sug.innerHTML = ""; };
    const drawSug = () => {
      const typed = PP.normalize(name.value);
      items = PP.logos.suggest(name.value, SUGGESTIONS).filter((e) => PP.normalize(e[0]) !== typed);
      sug.innerHTML = items.map((e, i) => {
        const img = libraryLogo(e);
        return `<button type="button" class="m-opt" data-i="${i}">
          ${img ? `<div class="logo img"><img src="${esc(img)}" alt=""></div>` : PP.logo({ name: e[0] })}<span>${esc(e[0])}</span></button>`;
      }).join("");
    };
    sug.addEventListener("click", (e) => {
      const o = e.target.closest("[data-i]");
      if (!o) return;
      const entry = items[Number(o.dataset.i)];
      if (!entry) return;
      name.value = entry[0];
      closeSug();
      onLogo(entry, true);
      $(nextSel).focus();
    });
    name.addEventListener("input", () => {
      drawSug();
      onLogo(PP.logos.find(name.value), false);
    });
    host.addEventListener("focusin", (e) => { if (e.target !== name && !sug.contains(e.target)) closeSug(); });
    $("#f-unlogo").addEventListener("click", () => {
      item.image = null;
      auto = false;
      setHint("");
      drawLogo();
    });
    drawLogo();
    return { input: name, closeSug };
  };
})();
