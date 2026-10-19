// Logique du coffre côté téléphone : mêmes règles que le PC (app/api.py, app/giftcards.py, app/textutil.py).
// Le coffre `v` a le format de Vault.to_dict() sans settings/sync : {version, profiles, accounts, giftcards, deleted}.
// Tout ce que ces fonctions produisent doit passer validate_phone_vault (app/syncflow.py) côté PC :
// horodatages « AAAA-MM-JJTHH:MM:SS » (heure locale), dates « AAAA-MM-JJ », montants finis >= 0.
//
// Contrat d'horodatage : le PC juge « modifié depuis la dernière synchro » avec SON horloge. Toute date écrite
// par le téléphone passe donc par stamp(now, lastSync, previous) ; `lastSync` est le dernier last_sync connu
// (optionnel, en dernier paramètre des fonctions de modification).
(function (root) {
  const LIGATURES = { "œ": "oe", "Œ": "oe", "æ": "ae", "Æ": "ae", "ß": "ss" };
  const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  const pad = (n, w = 2) => String(n).padStart(w, "0");

  function normalize(s) {
    s = String(s ?? "").replace(/[œŒæÆß]/g, (c) => LIGATURES[c]);
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function todayIso(d = new Date()) {
    return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function nowIso(d = new Date()) {
    return `${todayIso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function newId() {
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function empty() {
    return { version: 1, profiles: [], accounts: [], giftcards: [], deleted: [] };
  }

  // Secondes écoulées (UTC fictif, sans fuseau ni heure d'été) d'un horodatage local « AAAA-MM-JJTHH:MM:SS ».
  function toSeconds(ts) {
    const m = typeof ts === "string" ? TS_RE.exec(ts) : null;
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  }

  function fromSeconds(sec) {
    const d = new Date(sec * 1000);
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
      + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  // max(now, lastSync + 1 s, previous + 1 s) ; lastSync et previous absents ou invalides sont ignorés.
  function stamp(now, lastSync, previous) {
    let best = toSeconds(now);
    if (best === null) best = toSeconds(nowIso());
    for (const ref of [lastSync, previous]) {
      const s = toSeconds(ref);
      if (s !== null && s + 1 > best) best = s + 1;
    }
    return fromSeconds(best);
  }

  const inProfile = (profileId) => (x) => profileId == null || x.profiles.includes(profileId);

  function listAccounts(v, profileId) {
    return v.accounts.filter(inProfile(profileId)).sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const na = normalize(a.name), nb = normalize(b.name);
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }

  function listGiftcards(v, profileId) {
    return v.giftcards.filter(inProfile(profileId));
  }

  // « banque » devient « Banque » si cette catégorie existe déjà (évite les doublons de casse/accents).
  function categoryLabel(v, category) {
    category = String(category ?? "").replace(/\s+/g, " ").trim();
    const key = normalize(category);
    for (const a of v.accounts) {
      if (a.category && normalize(a.category) === key) return a.category;
    }
    return category;
  }

  function checkProfiles(v, profiles) {
    const valid = new Set(v.profiles.map((p) => p.id));
    const list = Array.isArray(profiles) ? profiles : [];
    const out = [...new Set(list)].filter((p) => valid.has(p));
    if (!out.length) throw new Error("Choisis au moins un profil");
    return out;
  }

  const str = (x) => (x == null ? "" : String(x));

  function saveAccount(v, data, now = nowIso(), lastSync = null) {
    const name = str(data.name).trim();
    if (!name) throw new Error("Le nom est obligatoire");
    const profiles = checkProfiles(v, data.profiles);
    const idx = v.accounts.findIndex((a) => a.id === data.id);
    const existing = idx >= 0 ? v.accounts[idx] : null;
    const updated = stamp(now, lastSync, existing && existing.updated);
    const acc = {
      id: existing ? existing.id : newId(),
      name,
      category: categoryLabel(v, data.category),
      login: str(data.login).trim(),
      password: str(data.password),
      login_mask: data.login_mask || null,
      password_mask: data.password_mask || null,
      image: data.image || null,
      favorite: Boolean(data.favorite),
      profiles,
      created: existing ? existing.created : updated,
      updated,
    };
    if (existing) v.accounts[idx] = acc;
    else v.accounts.push(acc);
    return acc;
  }

  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100 || 0;

  function toMoney(value, allowNone = false) {
    if (value == null || value === "") return allowNone ? null : 0;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error("Montant invalide");
    const r = round2(n);
    if (r < 0) throw new Error("Les montants ne peuvent pas être négatifs");
    return r;
  }

  function isValidDay(s) {
    const m = typeof s === "string" ? DAY_RE.exec(s) : null;
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  }

  function saveGiftcard(v, data, now = nowIso(), lastSync = null) {
    const name = str(data.name).trim();
    if (!name) throw new Error("Le nom est obligatoire");
    const end = data.end_date || null;
    if (end && !isValidDay(end)) throw new Error("Date de fin invalide");
    const idx = v.giftcards.findIndex((g) => g.id === data.id);
    const existing = idx >= 0 ? v.giftcards[idx] : null;
    const card = {
      id: existing ? existing.id : newId(),
      name,
      code: str(data.code).trim(),
      pin: str(data.pin).trim(),
      initial: toMoney(data.initial, true),
      remaining: toMoney(data.remaining),
      end_date: end,
      image: data.image || null,
      profiles: checkProfiles(v, data.profiles),
      history: existing ? existing.history : [],
      updated: stamp(now, lastSync, existing && existing.updated),
    };
    if (existing) v.giftcards[idx] = card;
    else v.giftcards.push(card);
    return card;
  }

  const COLLECTIONS = { account: "accounts", giftcard: "giftcards" };

  // Retire l'élément et laisse une pierre tombale datée après sa dernière modification.
  function deleteItem(v, kind, id, now = nowIso(), lastSync = null) {
    const key = COLLECTIONS[kind];
    if (!key) throw new Error("Type inconnu");
    const old = v[key].find((x) => x.id === id);
    v[key] = v[key].filter((x) => x.id !== id);
    v.deleted.push({ kind, id, at: stamp(now, lastSync, old && old.updated) });
  }

  function spend(v, id, amount, today = todayIso(), now = nowIso(), lastSync = null) {
    const idx = v.giftcards.findIndex((g) => g.id === id);
    if (idx < 0) throw new Error("Carte introuvable");
    const card = v.giftcards[idx];
    const n = Number(amount);
    if (!Number.isFinite(n)) throw new Error("Le montant doit être positif");
    const a = round2(n);
    if (a <= 0) throw new Error("Le montant doit être positif");
    if (a > round2(card.remaining) + 1e-9) throw new Error("Montant supérieur au solde restant");
    const next = {
      ...card,
      remaining: round2(card.remaining - a),
      history: [...card.history, { id: newId(), date: today, amount: a }],
      updated: stamp(now, lastSync, card.updated),
    };
    v.giftcards[idx] = next;
    return next;
  }

  function isFinished(card, today) {
    return card.remaining <= 0 || (card.end_date != null && card.end_date < today);
  }

  function dayNumber(s) {
    const m = DAY_RE.exec(s);
    return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000;
  }

  function expiringSoon(cards, today, days = 30) {
    return cards.filter((c) => !isFinished(c, today) && c.end_date && dayNumber(c.end_date) - dayNumber(today) <= days);
  }

  root.PPM = root.PPM || {};
  root.PPM.vault = {
    normalize, nowIso, todayIso, newId, empty, listAccounts, listGiftcards, categoryLabel,
    saveAccount, saveGiftcard, stamp, deleteItem, spend, isFinished, expiringSoon,
  };
  if (typeof module === "object") module.exports = root.PPM.vault;
})(typeof window !== "undefined" ? window : globalThis);
