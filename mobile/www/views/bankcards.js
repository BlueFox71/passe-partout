/* Téléphone — onglet Cartes : deux boutons en haut, « Bancaires » (cartes dessinées) et « Fidélité » (liste).
   Fiche plein écran avec un bouton copier par champ (secrets masqués) et formulaire ; l'identifiant d'une
   carte fidélité peut être scanné (code-barre). Contrat (coquille) : PP.views.bankcards.show(conteneur),
   clear(). Dessin et mise en forme des cartes bancaires partagés avec le PC : PP.bankcard (ui/app.js). */
(function () {
  const V = (PP.views.bankcards = {});
  const S = PP.state;
  const BC = PP.bankcard;
  const esc = (s) => PP.esc(s);

  let root = null; // élément .m-bc de l'onglet affiché
  let cards = []; // cartes du profil affiché (déchiffrées : oubliées au verrouillage)
  let seq = 0; // jeton d'affichage de l'onglet
  let sheetSeq = 0; // jeton de la fiche / du formulaire affiché par-dessus la liste
  let loadSeq = 0; // jeton de chargement : seule la réponse du dernier list_bankcards est affichée
  let shown = { cvv: false, pin: false }; // cryptogramme / code affichés en clair sur la fiche
  let kind = "bank"; // « bank » (cartes bancaires) ou « loyalty » (cartes fidélité) ; gardé d'un affichage à l'autre
  const LIST = { bank: "list_bankcards", loyalty: "list_loyaltycards" };

  const live = (token) => token === seq && !!root && root.isConnected;
  const hideSecrets = () => { shown = { cvv: false, pin: false }; };

  V.show = (container) => {
    seq++;
    sheetSeq++;
    hideSecrets();
    PP.mui.checkProfileFilter();
    container.innerHTML = `
      <div class="m-acc m-bc">
        <div class="m-acc-top">
          <div class="m-head m-acc-head"><h1>Cartes</h1><small id="bc-count"></small></div>
          <div class="seg m-bc-seg" id="bc-seg" role="tablist">
            <button type="button" data-k="bank">Bancaires</button><button type="button" data-k="loyalty">Fidélité</button></div>
          <div class="m-chips" id="bc-chips" role="toolbar" aria-label="Profils"></div>
        </div>
        <div class="m-acc-main">
          <div class="m-bc-list" id="bc-list"></div>
          <button type="button" class="m-fab m-gc-fab" id="bc-new" aria-label="Nouvelle carte">${PP.icon.plus}</button>
        </div>
        <div class="m-sheet" id="bc-sheet" hidden></div>
      </div>`;
    root = container.firstElementChild;
    const token = seq;
    root.querySelector("#bc-seg").addEventListener("click", (e) => {
      const b = e.target.closest("[data-k]");
      if (!b || b.dataset.k === kind) return;
      kind = b.dataset.k;
      cards = [];
      renderSeg();
      renderList();
      root.querySelector("#bc-list").scrollTop = 0;
      load(token);
    });
    root.querySelector("#bc-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-chip]");
      if (!b || !PP.mui.pickProfile(b.dataset.chip)) return;
      renderChips();
      load(token);
    });
    root.querySelector("#bc-list").addEventListener("click", (e) => {
      const it = e.target.closest("[data-id]");
      const b = it && cards.find((x) => x.id === it.dataset.id);
      if (b) openDetail(b);
    });
    root.querySelector("#bc-new").addEventListener("click", () => openForm(null));
    renderSeg();
    renderChips();
    renderList();
    load(token);
  };

  function renderSeg() {
    root.querySelectorAll("#bc-seg [data-k]").forEach((b) => {
      b.classList.toggle("on", b.dataset.k === kind);
      b.setAttribute("aria-selected", String(b.dataset.k === kind));
    });
  }

  async function load(token = seq) {
    const mine = ++loadSeq;
    const wanted = kind;
    let list;
    try {
      list = await PP.call(LIST[wanted], S.profileId ?? null);
    } catch (e) {
      return; // erreur déjà signalée par PP.call
    }
    if (!live(token) || mine !== loadSeq || wanted !== kind) return;
    cards = list;
    renderList();
  }

  // Au verrouillage (coquille) : plus aucune donnée du coffre à l'écran.
  V.clear = () => {
    seq++;
    sheetSeq++;
    cards = [];
    hideSecrets();
    if (root) root.innerHTML = "";
    root = null;
  };

  function renderChips() {
    root.querySelector("#bc-chips").innerHTML = PP.mui.profileChips();
  }

  function renderList() {
    if (!root) return;
    root.querySelector("#bc-count").textContent = `${cards.length} carte${cards.length > 1 ? "s" : ""}`;
    const listEl = root.querySelector("#bc-list");
    listEl.classList.toggle("m-lc-list", kind === "loyalty");
    if (kind === "loyalty") {
      listEl.innerHTML = cards.length
        ? cards.map((c) => `<button type="button" class="item m-item m-gc-item" data-id="${esc(c.id)}">
            ${BC.logo(c)}<span class="t"><b>${esc(c.name)}</b><small${c.number ? ' class="m-mono"' : ""}>${esc(c.number || "Sans identifiant")}</small></span>
          </button>`).join("")
        : `<div class="empty"><div class="big">🏷️</div>Aucune carte fidélité ici pour l'instant.</div>`;
      return;
    }
    listEl.innerHTML = cards.length
      ? cards.map((b) => `<button type="button" class="m-bc-item" data-id="${esc(b.id)}">${BC.visual(b)}</button>`).join("")
      : `<div class="empty"><div class="big">💳</div>Aucune carte bancaire ici pour l'instant.</div>`;
  }

  // ------------------------------------------------------------ fiche et formulaire (par-dessus la liste)
  const sheet = () => root.querySelector("#bc-sheet");

  function closeSheet() {
    sheetSeq++;
    hideSecrets();
    if (root) PP.mui.hideSheet(sheet());
  }

  function openDetail(b) {
    sheetSeq++;
    hideSecrets();
    if (kind === "loyalty") drawLoyalty(b, true);
    else drawDetail(b, true);
  }

  // [clé, libellé, valeur affichée, secret (masqué), texte copié, copie sensible (effacée après 30 s)]
  const rows = (b) => [
    ["number", "Numéro", BC.formatNumber(b.number), false, BC.digits(b.number), true],
    ["expiry", "Expiration", b.expiry, false, b.expiry, false],
    ["cvv", "Cryptogramme", b.cvv, true, b.cvv, true],
    ["pin", "Code", b.pin, true, b.pin, true],
    ["holder", "Titulaire", b.holder, false, b.holder, false],
  ];

  function drawDetail(b, top = false) {
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    const sh = sheet();
    const keep = sh.scrollTop;
    PP.mui.showSheet(sh);
    sh.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="d-back">${PP.icon.back}<span>Retour</span></button>
      </div>
      <div class="m-sheet-body">
        <div class="m-bc-big">${BC.visual(b, true)}</div>
        <div class="m-sub m-bc-profs">${esc(PP.mui.profileNames(b).join(" · "))}</div>
        ${rows(b).map(([key, label, value, secret]) => {
          if (!value) {
            return `<div class="fld m-fld"><div class="v"><span class="label">${label}</span>
              <div class="val"><span class="m-none">—</span></div></div></div>`;
          }
          const hide = secret && !shown[key];
          return `<div class="fld m-fld">
              <div class="v"><span class="label">${label}</span>
                <div class="val ${hide ? "masked" : "selectable"}">${hide ? "•".repeat(Math.min(8, Math.max(3, value.length))) : esc(value)}</div></div>
              ${secret ? `<button type="button" class="m-ibtn" data-eye="${key}" aria-label="${shown[key] ? "Masquer" : "Afficher"} ${label.toLowerCase()}">${shown[key] ? PP.icon.eyeOff : PP.icon.eye}</button>` : ""}
              <button type="button" class="m-ibtn" data-copy="${key}" aria-label="Copier ${label.toLowerCase()}">${PP.icon.copy}</button>
            </div>`;
        }).join("")}
        <button type="button" class="btn btn-primary m-wide" id="d-edit">${PP.icon.edit}Modifier</button>
        <button type="button" class="btn btn-danger m-wide" id="d-del">${PP.icon.trash}Supprimer la carte</button>
        ${b.updated ? `<div class="m-meta">Modifiée le ${PP.dateFr(String(b.updated).slice(0, 10))}</div>` : ""}
      </div>`;
    sh.scrollTop = top ? 0 : keep;

    const $ = (sel) => sh.querySelector(sel);
    $("#d-back").addEventListener("click", closeSheet);
    $("#d-edit").addEventListener("click", () => openForm(b));
    sh.querySelectorAll("[data-eye]").forEach((x) => x.addEventListener("click", () => {
      shown[x.dataset.eye] = !shown[x.dataset.eye];
      drawDetail(b);
    }));
    sh.querySelectorAll("[data-copy]").forEach((x) => x.addEventListener("click", () => {
      const [, label, , , text, sensitive] = rows(b).find((r) => r[0] === x.dataset.copy);
      (sensitive ? PP.copySecret(text, label) : PP.copyPlain(text, label)).catch(() => {});
    }));
    $("#d-del").addEventListener("click", async () => {
      const ok = await PP.confirm(`Supprimer la carte « ${b.name} » ?`,
        "Cette carte sera supprimée de ce téléphone, puis du PC à la prochaine synchronisation.",
        { ok: "Supprimer", danger: true });
      if (!ok || !sheetLive()) return;
      try {
        await PP.call("delete_bankcard", b.id);
      } catch (ex) {
        return; // message déjà affiché par PP.call
      }
      if (!sheetLive()) return;
      PP.toast("Carte supprimée");
      closeSheet();
      load(token);
    });
  }

  function openForm(card) {
    if (kind === "loyalty") return openLoyaltyForm(card);
    sheetSeq++;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    hideSecrets();
    const host = PP.mui.showSheet(sheet());
    const b = card
      ? { ...card }
      : { id: null, name: "", holder: "", number: "", expiry: "", cvv: "", pin: "", image: null, profiles: [] };
    const profs = new Set(card ? b.profiles || [] : PP.mui.defaultProfiles());
    let busy = false;
    const input = (id, label, value, attrs = "") => `
      <div class="field">
        <label for="${id}">${label}</label>
        <input class="input m-in m-mono" id="${id}" value="${esc(value)}" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false" enterkeyhint="next" ${attrs}>
      </div>`;

    host.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="b-cancel">${PP.icon.back}<span>Annuler</span></button>
        <div class="m-bar-title">${card ? "Modifier la carte" : "Nouvelle carte bancaire"}</div>
      </div>
      <form class="m-sheet-body m-form" id="b-form" novalidate autocomplete="off">
        ${PP.mui.nameField(b.name, "Société : Boursorama, Crédit Agricole…")}
        ${input("b-holder", "Titulaire", b.holder, 'autocapitalize="characters"')}
        ${input("b-number", "Numéro", BC.formatNumber(b.number), 'inputmode="numeric" placeholder="1234 5678 9012 3456"')}
        <div class="m-two">
          ${input("b-expiry", "Expiration", b.expiry, 'inputmode="numeric" placeholder="MM/AA" maxlength="5"')}
          ${input("b-cvv", "Cryptogramme", b.cvv, 'inputmode="numeric" maxlength="4"')}
        </div>
        ${input("b-pin", "Code", b.pin, 'inputmode="numeric"')}
        <div class="field">
          <label>Profils</label>
          <div class="checks m-checks" id="b-profs"></div>
        </div>
        <div class="err" id="b-err" role="alert"></div>
        <button type="submit" class="btn btn-primary m-wide" id="b-save">${PP.icon.check}Enregistrer</button>
      </form>`;

    const $ = (sel) => host.querySelector(sel);
    const { input: name, closeSug } = PP.mui.bindNameField(host, b, "#b-holder");
    PP.mui.profileChecks($("#b-profs"), profs);
    $("#b-number").addEventListener("input", (e) => {
      const el = e.target;
      if (el.selectionStart === el.value.length && /^[\d\s-]*$/.test(el.value)) el.value = BC.formatNumber(el.value);
    });
    $("#b-expiry").addEventListener("input", (e) => {
      if (e.inputType !== "deleteContentBackward" && /^\d{2}$/.test(e.target.value)) e.target.value += "/";
    });
    $("#b-cancel").addEventListener("click", () => {
      if (busy) return;
      if (card) openDetail(card);
      else closeSheet();
    });

    $("#b-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      closeSug();
      const err = $("#b-err");
      const rec = {
        ...b,
        name: name.value.trim(),
        holder: $("#b-holder").value.trim(),
        number: BC.formatNumber($("#b-number").value.trim()),
        expiry: $("#b-expiry").value.trim(),
        cvv: $("#b-cvv").value.trim(),
        pin: $("#b-pin").value.trim(),
        profiles: [...profs],
      };
      delete rec.updated; // horodatage posé par l'API locale
      if (!rec.name) { err.textContent = "Indique la société de la carte."; name.focus(); return; }
      if (!rec.profiles.length) { err.textContent = "Choisis au moins un profil."; return; }
      err.textContent = "";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // ferme le clavier
      busy = true;
      $("#b-save").disabled = true;
      let saved;
      try {
        saved = await PP.call("save_bankcard", rec);
      } catch (ex) {
        if (sheetLive()) { busy = false; $("#b-save").disabled = false; } // message déjà affiché par PP.call
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

  // ------------------------------------------------------------ cartes fidélité
  function drawLoyalty(c, top = false) {
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    const sh = sheet();
    const keep = sh.scrollTop;
    PP.mui.showSheet(sh);
    const none = `<span class="m-none">—</span>`;
    sh.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="d-back">${PP.icon.back}<span>Retour</span></button>
      </div>
      <div class="m-sheet-body">
        <div class="m-detail-head">
          ${BC.logo(c, "xl")}
          <h2 class="selectable">${esc(c.name)}</h2>
          <div class="m-sub">${esc(PP.mui.profileNames(c).join(" · "))}</div>
        </div>
        <div class="fld m-fld"><div class="v"><span class="label">Identifiant</span>
            <div class="val selectable m-mono">${c.number ? esc(c.number) : none}</div></div>
          ${c.number ? `<button type="button" class="m-ibtn" data-copy="number" aria-label="Copier l'identifiant">${PP.icon.copy}</button>` : ""}</div>
        <div class="fld m-fld"><div class="v"><span class="label">Code PIN</span>
            <div class="val ${shown.pin ? "selectable" : "masked"}">${!c.pin ? none : shown.pin ? esc(c.pin) : "•".repeat(Math.min(8, Math.max(4, c.pin.length)))}</div></div>
          ${c.pin ? `<button type="button" class="m-ibtn" data-eye="pin" aria-label="${shown.pin ? "Masquer" : "Afficher"} le code PIN">${shown.pin ? PP.icon.eyeOff : PP.icon.eye}</button>
            <button type="button" class="m-ibtn" data-copy="pin" aria-label="Copier le code PIN">${PP.icon.copy}</button>` : ""}</div>
        <button type="button" class="btn btn-primary m-wide" id="d-edit">${PP.icon.edit}Modifier</button>
        <button type="button" class="btn btn-danger m-wide" id="d-del">${PP.icon.trash}Supprimer la carte</button>
        ${c.updated ? `<div class="m-meta">Modifiée le ${PP.dateFr(String(c.updated).slice(0, 10))}</div>` : ""}
      </div>`;
    sh.scrollTop = top ? 0 : keep;
    const $ = (sel) => sh.querySelector(sel);
    $("#d-back").addEventListener("click", closeSheet);
    $("#d-edit").addEventListener("click", () => openLoyaltyForm(c));
    sh.querySelectorAll("[data-eye]").forEach((x) => x.addEventListener("click", () => {
      shown.pin = !shown.pin;
      drawLoyalty(c);
    }));
    sh.querySelectorAll("[data-copy]").forEach((x) => x.addEventListener("click", () => {
      (x.dataset.copy === "pin" ? PP.copySecret(c.pin, "Code PIN") : PP.copyPlain(c.number, "Identifiant")).catch(() => {});
    }));
    $("#d-del").addEventListener("click", async () => {
      const ok = await PP.confirm(`Supprimer la carte « ${c.name} » ?`,
        "Cette carte sera supprimée de ce téléphone, puis du PC à la prochaine synchronisation.",
        { ok: "Supprimer", danger: true });
      if (!ok || !sheetLive()) return;
      try {
        await PP.call("delete_loyaltycard", c.id);
      } catch (ex) {
        return; // message déjà affiché par PP.call
      }
      if (!sheetLive()) return;
      PP.toast("Carte supprimée");
      closeSheet();
      load(token);
    });
  }

  function openLoyaltyForm(card) {
    sheetSeq++;
    const token = seq;
    const mine = sheetSeq;
    const sheetLive = () => live(token) && mine === sheetSeq;
    hideSecrets();
    const host = PP.mui.showSheet(sheet());
    const c = card ? { ...card } : { id: null, name: "", number: "", pin: "", image: null, profiles: [] };
    const profs = new Set(card ? c.profiles || [] : PP.mui.defaultProfiles());
    let busy = false;
    host.innerHTML = `
      <div class="m-bar">
        <button type="button" class="m-back" id="l-cancel">${PP.icon.back}<span>Annuler</span></button>
        <div class="m-bar-title">${card ? "Modifier la carte" : "Nouvelle carte fidélité"}</div>
      </div>
      <form class="m-sheet-body m-form" id="l-form" novalidate autocomplete="off">
        ${PP.mui.nameField(c.name, "Enseigne : Leclerc, Fnac, Sephora…")}
        <div class="field">
          <label for="l-number">Identifiant <span class="m-opt-l">(facultatif)</span></label>
          <div class="m-scan-row">
            <input class="input m-in m-mono" id="l-number" value="${esc(c.number)}" autocomplete="off" autocapitalize="off"
              autocorrect="off" spellcheck="false" enterkeyhint="next">
            <button type="button" class="btn btn-ghost m-scan" id="l-scan">${PP.icon.barcode}Scanner</button>
          </div>
        </div>
        <div class="field">
          <label for="l-pin">Code PIN <span class="m-opt-l">(facultatif)</span></label>
          <input class="input m-in m-mono" id="l-pin" value="${esc(c.pin)}" inputmode="numeric" autocomplete="off"
            autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
        </div>
        <div class="field">
          <label>Profils</label>
          <div class="checks m-checks" id="l-profs"></div>
        </div>
        <div class="err" id="l-err" role="alert"></div>
        <button type="submit" class="btn btn-primary m-wide" id="l-save">${PP.icon.check}Enregistrer</button>
      </form>`;
    const $ = (sel) => host.querySelector(sel);
    const { input: name, closeSug } = PP.mui.bindNameField(host, c, "#l-number");
    PP.mui.profileChecks($("#l-profs"), profs);
    $("#l-scan").addEventListener("click", async () => {
      if (busy) return;
      let text;
      try {
        text = await PP.mobile.native.scanBarcode();
      } catch (e) {
        if (sheetLive()) {
          $("#l-err").textContent = e && e.code === "CAMERA_DENIED" && e.message ? e.message : "Impossible d'ouvrir l'appareil photo.";
        }
        return;
      }
      if (!sheetLive() || text == null) return; // scan annulé
      $("#l-number").value = String(text).trim();
      $("#l-err").textContent = "";
      PP.toast("Code-barre lu");
    });
    $("#l-cancel").addEventListener("click", () => {
      if (busy) return;
      if (card) openDetail(card);
      else closeSheet();
    });
    $("#l-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (busy) return;
      closeSug();
      const err = $("#l-err");
      const rec = { ...c, name: name.value.trim(), number: $("#l-number").value.trim(), pin: $("#l-pin").value.trim(), profiles: [...profs] };
      delete rec.updated; // horodatage posé par l'API locale
      if (!rec.name) { err.textContent = "Indique l'enseigne de la carte."; name.focus(); return; }
      if (!rec.profiles.length) { err.textContent = "Choisis au moins un profil."; return; }
      err.textContent = "";
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // ferme le clavier
      busy = true;
      $("#l-save").disabled = true;
      let saved;
      try {
        saved = await PP.call("save_loyaltycard", rec);
      } catch (ex) {
        if (sheetLive()) { busy = false; $("#l-save").disabled = false; } // message déjà affiché par PP.call
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
