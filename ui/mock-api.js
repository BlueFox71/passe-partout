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
  let settings = { autolock_minutes: 10 };
  let lock = { mode: params.has("sansverrou") ? "none" : "pin", code: "123456" };
  let locked = lock.mode !== "none";
  let hasData = !params.has("bienvenue");
  let fails = 0, waitUntil = 0;
  const backups = [
    { name: "vault-20261018-101500.json", date: "18/10/2026 10:15" },
    { name: "vault-20261017-213012.json", date: "17/10/2026 21:30" },
  ];

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
      return { locked, lock_mode: lock.mode, has_data: hasData, corrupt: params.has("corrompu"), profiles: clone(profiles), mock: true };
    },
    async unlock(code) {
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
      for (const x of [...accounts, ...giftcards]) {
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
