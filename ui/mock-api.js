/* Maquette de l'API Python, en mémoire, sur données fictives.
   Utilisée quand l'interface est ouverte dans un navigateur (hors pywebview). */
(function () {
  const uid = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const now = () => new Date().toISOString();
  const iso = (days) => {
    const d = new Date(Date.now() + days * 86400000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const params = new URLSearchParams(location.search);

  const profiles = [
    { id: "p1", name: "Jules", avatar: null, color: "#ff3d9a" },
    { id: "p2", name: "Alexis", avatar: null, color: "#00b8d9" },
  ];
  const A = (name, category, login, password, extra = {}) => ({
    id: uid(), name, category, login, password, login_mask: null, password_mask: null, image: null,
    favorite: false, profiles: ["p1"], created: now(), updated: now(), ...extra,
  });
  const accounts = [
    A("Boursorama", "Banque", "48213377", "Tr0mpette!Bleue", { favorite: true }),
    A("Carte Bleue", "Banque", "4970 •••• 1234", "482", { password_mask: null }),
    A("Carte Bleu Alexis", "Banque", "5131 4567 8901 2346", "1234", { profiles: ["p2"] }),
    A("PayPal", "Banque", "jules@exemple.fr", "Papillon#2024", { profiles: ["p1", "p2"] }),
    A("Gmail", "Boîte mail", "jules@exemple.fr", "Nuage-Violet-88", { favorite: true }),
    A("Outlook", "Boîte mail", "alexis@exemple.fr", "soleil2019", { profiles: ["p2"] }),
    A("Impôts", "État", "1234567890123", "Fisc@lite2026", { login_mask: "## ## ### ### ###", favorite: true }),
    A("Ameli", "Santé", "185067512345678", "Vitale!Carte77", { login_mask: "# ## ## ## ### ### ##" }),
    A("CAF", "État", "7654321", "Allocs2025", { profiles: ["p1", "p2"] }),
    A("ANTS", "État", "jules@exemple.fr", "PermisB!2010"),
    A("Steam", "Plateforme de jeu", "julesgamer", "GabeN-3-confirmed"),
    A("Epic Games", "Plateforme de jeu", "julesgamer", "Fortnite4ever"),
    A("Battle.net", "Plateforme de jeu", "Jules#2187", "Murloc!Mrglgl"),
    A("Nintendo", "Plateforme de jeu", "jules.switch", "Mario64!", { profiles: ["p1", "p2"] }),
    A("Discord", "Réseau social", "jules_rp", "D20-critique!"),
    A("Instagram", "Réseau social", "alexis.photo", "insta1234", { profiles: ["p2"] }),
    A("Facebook", "Réseau social", "alexis@exemple.fr", "fb-Alexis-01", { profiles: ["p2"] }),
    A("Netflix", "Streaming", "famille@exemple.fr", "Chill&Popcorn9", { profiles: ["p1", "p2"], favorite: true }),
    A("Spotify", "Streaming", "jules@exemple.fr", "Playlist_Epique"),
    A("Amazon", "Site Web", "jules@exemple.fr", "Colis!Rapide42", { profiles: ["p1", "p2"] }),
    A("Leboncoin", "Site Web", "jules@exemple.fr", "Bonnaffaire1"),
    A("Roll20", "Site Web", "jules_mj", "Initiative+5"),
    A("Free", "Informatique", "fbx12345678", "Freebox-Delta"),
    A("NAS Synology", "Informatique", "admin", "S4uvegarde!NAS"),
    A("Macif", "Voiture", "998877", "Assur@nce2026", { profiles: ["p1", "p2"] }),
    A("Leclerc", "Magasin", "jules@exemple.fr", "Courses123", { profiles: ["p2"] }),
  ];
  const G = (name, remaining, end, extra = {}) => ({
    id: uid(), name, code: String(Math.floor(1e15 + Math.random() * 9e15)), pin: String(1000 + Math.floor(Math.random() * 9000)),
    initial: remaining, remaining, end_date: end, image: null, profiles: ["p1"], history: [], ...extra,
  });
  const giftcards = [
    G("Fnac", 50, iso(10)),
    G("Amazon", 25.5, iso(200), { initial: 40, history: [{ date: iso(-12), amount: 14.5 }] }),
    G("Decathlon", 80, null, { profiles: ["p2"] }),
    G("Sephora", 0, iso(90), { initial: 30, history: [{ date: iso(-40), amount: 30 }], profiles: ["p2"] }),
  ];
  const B = (name, holder, number, expiry, extra = {}) => ({
    id: uid(), name, holder, number, expiry, cvv: String(100 + Math.floor(Math.random() * 900)),
    pin: String(1000 + Math.floor(Math.random() * 9000)), image: null, profiles: ["p1"], updated: now(), ...extra,
  });
  const bankcards = [
    B("Boursorama", "JULES CANNET", "4970 1234 5678 1234", "12/28"),
    B("Revolut", "JULES CANNET", "5355 2210 9876 5432", "03/27", { profiles: ["p1", "p2"] }),
  ];
  const loyaltycards = [
    { id: uid(), name: "Leclerc", number: "2912345678901", pin: "", image: null, profiles: ["p1", "p2"], updated: now() },
    { id: uid(), name: "Sephora", number: "", pin: "4821", image: null, profiles: ["p2"], updated: now() },
  ];
  // même règle que app/bankcards.py : réseau reconnu, bonne longueur, clé de Luhn valide
  const isCardNumber = (d) => {
    if (!/^\d{13,19}$/.test(d)) return false;
    const ok = (d[0] === "4" && [13, 16, 19].includes(d.length))
      || (d.length === 16 && ((+d.slice(0, 2) >= 51 && +d.slice(0, 2) <= 55) || (+d.slice(0, 4) >= 2221 && +d.slice(0, 4) <= 2720)))
      || (d.length === 15 && ["34", "37"].includes(d.slice(0, 2)));
    let sum = 0;
    [...d].reverse().forEach((c, i) => { let n = +c * (i % 2 ? 2 : 1); sum += n > 9 ? n - 9 : n; });
    return ok && sum % 10 === 0;
  };
  // comme le PC : les comptes dont l'identifiant est un numéro de carte deviennent des cartes (une fois)
  let converted = 0;
  for (const a of [...accounts]) {
    const digits = a.login.replace(/[\s-]/g, "");
    if (!isCardNumber(digits)) continue;
    const cvv = /^\d{3}$/.test(a.password);
    bankcards.push({ id: a.id, name: a.name, holder: "", number: digits, expiry: "", cvv: cvv ? a.password : "",
      pin: cvv ? "" : a.password, image: a.image, profiles: a.profiles, updated: now() });
    accounts.splice(accounts.indexOf(a), 1);
    converted++;
  }
  let settings = { autolock_minutes: 10 };
  let lock = { mode: params.has("sansverrou") ? "none" : "pin", code: "123456" };
  let hasData = !params.has("bienvenue");
  if (!hasData) lock = { mode: "none", code: null };
  let locked = lock.mode !== "none";
  let fails = 0, waitUntil = 0;
  const backups = [
    { name: "vault-20261018-101500.json", date: "18/10/2026 10:15" },
    { name: "vault-20261017-213012.json", date: "17/10/2026 21:30" },
  ];

  let devices = [
    { id: "d1", name: "Pixel de Jules", last_sync: "2026-10-18T21:42:10" },
    { id: "d2", name: "Téléphone d'Alexis", last_sync: "2026-10-12T08:05:00" },
  ];
  let sync = null; // { t0 }
  let apk = null;  // { t0 }
  const FAKE_QR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29" shape-rendering="crispEdges"><rect width="29" height="29" fill="#fff"/>' +
    [[2, 2], [20, 2], [2, 20]].map(([x, y]) => `<path d="M${x} ${y}h7v7h-7z" fill="#000"/><path d="M${x + 1} ${y + 1}h5v5h-5z" fill="#fff"/><path d="M${x + 2} ${y + 2}h3v3h-3z" fill="#000"/>`).join("") +
    Array.from({ length: 90 }, (_, i) => `<rect x="${10 + (i * 7) % 17}" y="${3 + (i * 11) % 24}" width="1" height="1" fill="#000"/>`).join("") + "</svg>";

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const need = () => { if (locked) throw new Error("Coffre verrouillé"); };
  const inProfile = (pid) => (x) => pid == null || x.profiles.includes(pid);
  const sortAccounts = (list) =>
    list.sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

  function resizeDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 256 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("Ce n'est pas une image"));
      img.src = dataUrl;
    });
  }

  window.MockApi = {
    async get_state() {
      const conv = locked ? 0 : converted;
      if (!locked) converted = 0;
      return { locked, lock_mode: lock.mode, pin_length: lock.mode === "pin" ? (lock.code || "").length : null, has_data: hasData, corrupt: params.has("corrompu"), profiles: clone(profiles), mock: true, converted_cards: conv };
    },
    async unlock(code) {
      await new Promise((r) => setTimeout(r, 400)); // comme la vraie dérivation de clé
      const wait = Math.ceil((waitUntil - Date.now()) / 1000);
      if (wait > 0) return { ok: false, wait_seconds: wait, error: "bad_code" };
      if (code === lock.code) { locked = false; fails = 0; return { ok: true, wait_seconds: 0 }; }
      fails++;
      const d = Math.min(2 ** (fails - 1), 300);
      waitUntil = Date.now() + d * 1000;
      return { ok: false, wait_seconds: d, error: "bad_code" };
    },
    async lock() { if (lock.mode !== "none") locked = true; return {}; },
    async list_backups() { return clone(backups); },
    async restore_backup() { params.delete("corrompu"); return {}; },

    async list_accounts(pid) { need(); return clone(sortAccounts(accounts.filter(inProfile(pid)))); },
    async save_account(a) {
      need();
      if (!a.name || !a.name.trim()) throw new Error("Le nom est obligatoire");
      if (!a.profiles || !a.profiles.length) throw new Error("Choisis au moins un profil");
      const i = accounts.findIndex((x) => x.id === a.id);
      const rec = { ...a, updated: now() };
      if (i >= 0) accounts[i] = rec; else { rec.id = uid(); rec.created = now(); accounts.push(rec); }
      return clone(rec);
    },
    async delete_account(id) { need(); accounts.splice(accounts.findIndex((x) => x.id === id), 1); return {}; },
    async bulk_update(ids, ch) {
      need();
      for (const a of accounts.filter((x) => ids.includes(x.id))) {
        if (ch.category) a.category = ch.category;
        for (const p of ch.add_profiles || []) if (!a.profiles.includes(p)) a.profiles.push(p);
        const rest = a.profiles.filter((p) => !(ch.remove_profiles || []).includes(p));
        if (rest.length) a.profiles = rest;
      }
      return {};
    },

    async list_giftcards(pid) { need(); return clone(giftcards.filter(inProfile(pid))); },
    async save_giftcard(g) {
      need();
      if (!g.name || !g.name.trim()) throw new Error("Le nom est obligatoire");
      if (!g.profiles || !g.profiles.length) throw new Error("Choisis au moins un profil");
      const i = giftcards.findIndex((x) => x.id === g.id);
      const rec = { history: [], ...g };
      if (i >= 0) giftcards[i] = rec; else { rec.id = uid(); giftcards.push(rec); }
      return clone(rec);
    },
    async delete_giftcard(id) { need(); giftcards.splice(giftcards.findIndex((x) => x.id === id), 1); return {}; },
    async spend(id, amount) {
      need();
      const g = giftcards.find((x) => x.id === id);
      amount = Math.round(Number(amount) * 100) / 100;
      if (!(amount > 0)) throw new Error("Le montant doit être positif");
      if (amount > g.remaining + 1e-9) throw new Error("Montant supérieur au solde restant");
      g.remaining = Math.round((g.remaining - amount) * 100) / 100;
      g.history.push({ date: iso(0), amount });
      return clone(g);
    },

    async list_bankcards(pid) {
      need();
      return clone(bankcards.filter(inProfile(pid)).sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" })));
    },
    async save_bankcard(b) {
      need();
      if (!b.name || !b.name.trim()) throw new Error("Le nom est obligatoire");
      if (!b.profiles || !b.profiles.length) throw new Error("Choisis au moins un profil");
      let exp = String(b.expiry || "").replace(/\s/g, "");
      const m = /^(\d{1,2})[/.-]?(\d{2}|\d{4})$/.exec(exp);
      if (m) exp = `${m[1].padStart(2, "0")}/${m[2].slice(-2)}`;
      if (exp && !/^(0[1-9]|1[0-2])\/\d{2}$/.test(exp)) throw new Error("Date d'expiration invalide (format MM/AA)");
      const i = bankcards.findIndex((x) => x.id === b.id);
      const rec = { ...b, name: b.name.trim(), expiry: exp, updated: now() };
      if (i >= 0) bankcards[i] = rec; else { rec.id = uid(); bankcards.push(rec); }
      return clone(rec);
    },
    async delete_bankcard(id) { need(); bankcards.splice(bankcards.findIndex((x) => x.id === id), 1); return {}; },

    async list_loyaltycards(pid) {
      need();
      return clone(loyaltycards.filter(inProfile(pid)).sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" })));
    },
    async save_loyaltycard(c) {
      need();
      if (!c.name || !c.name.trim()) throw new Error("Le nom est obligatoire");
      if (!c.profiles || !c.profiles.length) throw new Error("Choisis au moins un profil");
      const i = loyaltycards.findIndex((x) => x.id === c.id);
      const rec = { ...c, name: c.name.trim(), number: String(c.number || "").trim(), pin: String(c.pin || "").trim(), updated: now() };
      if (i >= 0) loyaltycards[i] = rec; else { rec.id = uid(); loyaltycards.push(rec); }
      return clone(rec);
    },
    async delete_loyaltycard(id) { need(); loyaltycards.splice(loyaltycards.findIndex((x) => x.id === id), 1); return {}; },

    async save_profile(p) {
      need();
      if (!p.name || !p.name.trim()) throw new Error("Le nom est obligatoire");
      const i = profiles.findIndex((x) => x.id === p.id);
      if (i >= 0) profiles[i] = { ...p }; else { p = { ...p, id: uid() }; profiles.push(p); }
      return clone(p);
    },
    async delete_profile(id, reassignTo) {
      need();
      if (profiles.length <= 1) throw new Error("Il faut garder au moins un profil");
      for (const x of [...accounts, ...giftcards, ...bankcards, ...loyaltycards]) {
        if (!x.profiles.includes(id)) continue;
        x.profiles = x.profiles.filter((p) => p !== id);
        if (!x.profiles.length) x.profiles = [reassignTo];
      }
      profiles.splice(profiles.findIndex((x) => x.id === id), 1);
      return {};
    },

    async copy_secret(text) { await navigator.clipboard.writeText(text).catch(() => {}); return {}; },
    async copy_plain(text) { await navigator.clipboard.writeText(text).catch(() => {}); return {}; },
    pick_image() {
      return new Promise((resolve) => {
        const inp = document.createElement("input");
        inp.type = "file"; inp.accept = "image/*";
        inp.onchange = () => {
          const f = inp.files[0];
          if (!f) return resolve(null);
          const r = new FileReader();
          r.onload = () => resizeDataUrl(r.result).then(resolve, () => resolve(null));
          r.readAsDataURL(f);
        };
        inp.click();
      });
    },
    async normalize_image(dataUrl) { return resizeDataUrl(dataUrl); },

    async set_lock(mode, code) { lock = { mode, code }; return {}; },
    async get_settings() { return clone(settings); },
    async save_settings(s) { settings = { ...settings, ...s }; return clone(settings); },
    async open_backups_folder() { return {}; },
    async sync_start() { need(); sync = { t0: Date.now() }; return { qr: FAKE_QR, seconds: 120, hosts: ["192.168.1.20"] }; },
    async sync_status() {
      if (!sync) return { state: "closed", seconds_left: 0, device: null, summary: null, error: null, notice: null, update: false };
      const dt = (Date.now() - sync.t0) / 1000;
      const left = Math.max(0, Math.round(120 - dt));
      if (dt < 1.5) return { state: "waiting", seconds_left: left, device: null, summary: null, error: null, notice: null, update: false };
      if (dt < 4) return { state: "syncing", seconds_left: left, device: "Pixel de Jules", summary: null, error: dt < 2.5 ? "Code incorrect, réessaie sur le téléphone." : null,
        notice: dt < 3 ? "Pixel de Jules doit être mis à jour (1.0.0 → 1.1.0)" : "✓ Appli envoyée à Pixel de Jules", update: true };
      if (!devices.some((d) => d.id === "d1")) devices.unshift({ id: "d1", name: "Pixel de Jules", last_sync: now().slice(0, 19) });
      return { state: "done", seconds_left: left, device: "Pixel de Jules", summary: { to_pc: 3, to_phone: 5, deleted: 1, conflicts: 1 }, error: null, notice: "✓ Appli envoyée à Pixel de Jules", update: true };
    },
    async sync_stop() { sync = null; return {}; },
    async get_app_info() { return { version: "1.0.0", apk: true }; },
    async apk_install_start() {
      need();
      apk = { t0: Date.now() };
      const urls = ["http://192.168.1.20:50200/abc123/passe-partout-1.0.0.apk", "http://10.0.0.5:50200/abc123/passe-partout-1.0.0.apk"];
      return { qr: FAKE_QR, url: urls[0], urls, seconds: 300, version: "1.0.0" };
    },
    async apk_qr(url) { return FAKE_QR.replace("#fff", "#fff").replace("<rect ", '<rect data-u="' + url.length + '" '); },
    async apk_install_status() {
      if (!apk) return { state: "closed", seconds_left: 0, downloads: 0 };
      const dt = (Date.now() - apk.t0) / 1000;
      if (dt < 4) return { state: "waiting", seconds_left: Math.max(0, Math.round(300 - dt)), downloads: 0 };
      return { state: "done", seconds_left: 0, downloads: 1 };
    },
    async apk_install_stop() { apk = null; return {}; },
    async list_devices() { return clone(devices); },
    async forget_device(id) { devices = devices.filter((d) => d.id !== id); return {}; },
    async replace_images(accs, cards) {
      let n = 0;
      for (const [list, map] of [[accounts, accs || {}], [giftcards, cards || {}]])
        for (const x of list) { const p = map[x.id]; if (p && x.image === p[0]) { x.image = p[1]; n++; } }
      return n;
    },
    async set_images(accs, cards) {
      let n = 0;
      for (const [list, map] of [[accounts, accs], [giftcards, cards]])
        for (const x of list) if (map[x.id] && !x.image) { x.image = map[x.id]; n++; }
      return n;
    },
    async preview_import() { return { path: "C:/maquette/mdps.xlsx", added: 12, skipped: 118 }; },
    async import_excel(path, profileName) {
      if (!hasData) { hasData = true; profiles.splice(1); profiles[0].name = profileName || "Moi"; }
      return { added: 130, skipped: 0 };
    },
    async start_empty(profileName) { hasData = true; profiles.splice(1); profiles[0].name = profileName || "Moi"; return {}; },
    async export(kind, ids, withCards) {
      const n = kind === "txt" ? 1 : Math.max(1, new Set(accounts.filter((a) => ids.includes(a.id)).map((a) => a.category)).size);
      return { files: Array.from({ length: n }, (_, i) => `C:\\Users\\…\\Export\\fichier-${i + 1}.${kind}`) };
    },
  };
})();
