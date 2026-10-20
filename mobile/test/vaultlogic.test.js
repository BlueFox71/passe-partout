// Tests de la logique du coffre du téléphone (règles de app/api.py et app/giftcards.py).
const test = require("node:test");
const assert = require("node:assert");
require("../www/js/vaultlogic.js");
const V = globalThis.PPM.vault;

const T0 = "2026-10-19T10:00:00";
function base() {
  const v = V.empty();
  v.profiles.push({ id: "p1", name: "Moi", avatar: null, color: "#fff", updated: T0 });
  v.profiles.push({ id: "p2", name: "Autre", avatar: null, color: "#000", updated: T0 });
  return v;
}

test("normalize comme le PC", () => {
  assert.equal(V.normalize("  Réseau   SOCIAL "), "reseau social");
  assert.equal(V.normalize("Œuvre"), "oeuvre");
  assert.equal(V.normalize("Straße æ"), "strasse ae");
  assert.equal(V.normalize(null), "");
});

test("newId : 32 hexadécimaux minuscules", () => {
  assert.match(V.newId(), /^[0-9a-f]{32}$/);
  assert.notEqual(V.newId(), V.newId());
});

test("nowIso / todayIso en heure locale", () => {
  const d = new Date(2026, 0, 5, 3, 4, 9);
  assert.equal(V.nowIso(d), "2026-01-05T03:04:09");
  assert.equal(V.todayIso(d), "2026-01-05");
});

test("saveAccount exige un nom et un profil connu", () => {
  const v = base();
  assert.throws(() => V.saveAccount(v, { name: "  ", profiles: ["p1"] }, T0), /Le nom est obligatoire/);
  assert.throws(() => V.saveAccount(v, { name: "A", profiles: ["zz"] }, T0), /Choisis au moins un profil/);
  assert.throws(() => V.saveAccount(v, { name: "A" }, T0), /Choisis au moins un profil/);
  assert.equal(v.accounts.length, 0);
  const a = V.saveAccount(v, { name: " A ", profiles: ["p1", "p1", "zz"], favorite: 1 }, T0);
  assert.deepEqual(a.profiles, ["p1"]);
  assert.equal(a.name, "A");
  assert.equal(a.favorite, true);
  assert.equal(v.accounts.length, 1);
});

test("saveAccount : updated = now, created conservé en modification", () => {
  const v = base();
  const a = V.saveAccount(v, { name: "A", profiles: ["p1"] }, T0);
  assert.equal(a.created, T0);
  assert.equal(a.updated, T0);
  const b = V.saveAccount(v, { id: a.id, name: "A2", profiles: ["p2"] }, "2026-10-19T11:00:00");
  assert.equal(b.id, a.id);
  assert.equal(b.created, T0);
  assert.equal(b.updated, "2026-10-19T11:00:00");
  assert.equal(v.accounts.length, 1);
  assert.equal(v.accounts[0].name, "A2");
});

test("categoryLabel : « banque » devient « Banque » si elle existe", () => {
  const v = base();
  V.saveAccount(v, { name: "A", category: "Banque", profiles: ["p1"] }, T0);
  assert.equal(V.categoryLabel(v, " banque "), "Banque");
  assert.equal(V.categoryLabel(v, "Réseaux   sociaux"), "Réseaux sociaux");
  const b = V.saveAccount(v, { name: "B", category: "BANQUE", profiles: ["p1"] }, T0);
  assert.equal(b.category, "Banque");
});

test("deleteItem ajoute une pierre tombale", () => {
  const v = base();
  const a = V.saveAccount(v, { name: "A", profiles: ["p1"] }, T0);
  const c = V.saveGiftcard(v, { name: "C", profiles: ["p1"], remaining: 5 }, T0);
  V.deleteItem(v, "account", a.id, "2026-10-19T12:00:00");
  V.deleteItem(v, "giftcard", c.id, "2026-10-19T12:00:00");
  assert.equal(v.accounts.length, 0);
  assert.equal(v.giftcards.length, 0);
  assert.deepEqual(v.deleted, [
    { kind: "account", id: a.id, at: "2026-10-19T12:00:00" },
    { kind: "giftcard", id: c.id, at: "2026-10-19T12:00:00" },
  ]);
});

test("saveGiftcard : validations et montants", () => {
  const v = base();
  assert.throws(() => V.saveGiftcard(v, { name: "", profiles: ["p1"] }, T0), /Le nom est obligatoire/);
  assert.throws(() => V.saveGiftcard(v, { name: "C", profiles: [] }, T0), /Choisis au moins un profil/);
  assert.throws(() => V.saveGiftcard(v, { name: "C", profiles: ["p1"], remaining: -1 }, T0),
    /Les montants ne peuvent pas être négatifs/);
  assert.throws(() => V.saveGiftcard(v, { name: "C", profiles: ["p1"], end_date: "pas une date" }, T0));
  assert.throws(() => V.saveGiftcard(v, { name: "C", profiles: ["p1"], end_date: "2026-02-30" }, T0));
  const c = V.saveGiftcard(v, { name: "C", profiles: ["p1"], initial: "", remaining: "12.345", end_date: "" }, T0);
  assert.equal(c.initial, null);
  assert.equal(c.remaining, 12.35);
  assert.equal(c.end_date, null);
  assert.deepEqual(c.history, []);
});

test("saveGiftcard : l'historique est conservé en modification", () => {
  const v = base();
  const c = V.saveGiftcard(v, { name: "C", profiles: ["p1"], remaining: 20 }, T0);
  V.spend(v, c.id, 5, "2026-10-19", T0);
  const m = V.saveGiftcard(v, { id: c.id, name: "C2", profiles: ["p1"], remaining: 15 }, "2026-10-19T13:00:00");
  assert.equal(m.history.length, 1);
  assert.equal(m.updated, "2026-10-19T13:00:00");
});

test("spend : id d'historique, solde arrondi, updated = now ; montant > solde refusé", () => {
  const v = base();
  const c = V.saveGiftcard(v, { name: "C", profiles: ["p1"], initial: 50, remaining: 10.1 }, T0);
  const s = V.spend(v, c.id, 0.2, "2026-10-19", "2026-10-19T14:00:00");
  assert.equal(s.remaining, 9.9);
  assert.equal(s.updated, "2026-10-19T14:00:00");
  assert.equal(s.history.length, 1);
  assert.match(s.history[0].id, /^[0-9a-f]{32}$/);
  assert.equal(s.history[0].date, "2026-10-19");
  assert.equal(s.history[0].amount, 0.2);
  assert.equal(v.giftcards[0].remaining, 9.9);
  assert.throws(() => V.spend(v, c.id, 0, "2026-10-19", T0), /Le montant doit être positif/);
  assert.throws(() => V.spend(v, c.id, -3, "2026-10-19", T0), /Le montant doit être positif/);
  assert.throws(() => V.spend(v, c.id, 9.91, "2026-10-19", T0), /Montant supérieur au solde restant/);
  assert.throws(() => V.spend(v, "nope", 1, "2026-10-19", T0), /Carte introuvable/);
  V.spend(v, c.id, 9.9, "2026-10-19", T0);
  assert.equal(v.giftcards[0].remaining, 0);
});

test("stamp : horloge du téléphone en retard sur le PC → date = last_sync + 1 s ; jamais ≤ l'updated précédent", () => {
  assert.equal(V.stamp("2026-10-19T10:00:00", null, null), "2026-10-19T10:00:00");
  // téléphone en retard : last_sync (horloge du PC) est dans le futur du téléphone
  assert.equal(V.stamp("2026-10-19T10:00:00", "2026-10-19T10:03:00", null), "2026-10-19T10:03:01");
  assert.equal(V.stamp("2026-10-19T10:00:00", "2026-10-19T09:00:00", null), "2026-10-19T10:00:00");
  // jamais ≤ updated précédent
  assert.equal(V.stamp("2026-10-19T10:00:00", null, "2026-10-19T10:00:00"), "2026-10-19T10:00:01");
  assert.equal(V.stamp("2026-10-19T10:00:00", "2026-10-19T09:00:00", "2026-10-19T10:05:00"), "2026-10-19T10:05:01");
  // débordements : minute, jour, année
  assert.equal(V.stamp("2026-12-31T23:59:59", "2026-12-31T23:59:59", null), "2027-01-01T00:00:00");
  assert.equal(V.stamp("2026-10-19T10:00:00", "", null), "2026-10-19T10:00:00");
});

test("les fonctions de modification appliquent stamp avec last_sync", () => {
  const v = base();
  const a = V.saveAccount(v, { name: "A", profiles: ["p1"] }, "2026-10-19T10:00:00", "2026-10-19T10:03:00");
  assert.equal(a.updated, "2026-10-19T10:03:01");
  const b = V.saveAccount(v, { id: a.id, name: "A", profiles: ["p1"] }, "2026-10-19T10:00:00");
  assert.equal(b.updated, "2026-10-19T10:03:02"); // strictement après l'updated précédent
  const c = V.saveGiftcard(v, { name: "C", profiles: ["p1"], remaining: 10 }, T0, "2026-10-19T10:03:00");
  const s = V.spend(v, c.id, 1, "2026-10-19", T0, "2026-10-19T10:03:00");
  assert.equal(s.updated, "2026-10-19T10:03:02");
  V.deleteItem(v, "account", a.id, T0, "2026-10-19T10:03:00");
  assert.equal(v.deleted[0].at, "2026-10-19T10:03:03"); // après l'updated de l'élément supprimé
});

test("listAccounts : favoris d'abord, ordre alphabétique sans accents, filtre profil", () => {
  const v = base();
  V.saveAccount(v, { name: "zèbre", profiles: ["p1"] }, T0);
  V.saveAccount(v, { name: "Élan", profiles: ["p1"] }, T0);
  V.saveAccount(v, { name: "Ours", profiles: ["p2"], favorite: true }, T0);
  V.saveAccount(v, { name: "abeille", profiles: ["p1", "p2"] }, T0);
  assert.deepEqual(V.listAccounts(v, null).map((a) => a.name), ["Ours", "abeille", "Élan", "zèbre"]);
  assert.deepEqual(V.listAccounts(v, "p1").map((a) => a.name), ["abeille", "Élan", "zèbre"]);
  V.saveGiftcard(v, { name: "G", profiles: ["p2"] }, T0);
  assert.equal(V.listGiftcards(v, "p1").length, 0);
  assert.equal(V.listGiftcards(v, null).length, 1);
});

test("isFinished et expiringSoon : 30 jours, ignore cartes finies", () => {
  const today = "2026-10-19";
  const mk = (remaining, end_date) => ({ id: V.newId(), name: "x", remaining, end_date });
  assert.equal(V.isFinished(mk(0, null), today), true);
  assert.equal(V.isFinished(mk(5, "2026-10-18"), today), true);
  assert.equal(V.isFinished(mk(5, "2026-10-19"), today), false);
  assert.equal(V.isFinished(mk(5, null), today), false);
  const dans30 = mk(5, "2026-11-18");
  const dans31 = mk(5, "2026-11-19");
  const finie = mk(0, "2026-10-25");
  const perimee = mk(5, "2026-10-01");
  const sans = mk(5, null);
  assert.deepEqual(V.expiringSoon([dans30, dans31, finie, perimee, sans], today), [dans30]);
  assert.deepEqual(V.expiringSoon([dans31], today, 31), [dans31]);
});

test("les données produites passent la validation du PC (validate_phone_vault)", () => {
  const v = base();
  const sync = "2026-10-19T10:03:00";
  const IMG = "data:image/png;base64,AAAA";
  const a = V.saveAccount(v, { name: "A", category: "Banque", login: "me", password: "x", image: IMG, profiles: ["p1"] }, T0, sync);
  V.saveAccount(v, { id: a.id, name: "A", profiles: ["p1"], login_mask: "" }, T0, sync);
  const g = V.saveGiftcard(v, { name: "G", profiles: ["p1"], initial: 50, remaining: 20.5, end_date: "2027-01-31" }, T0, sync);
  V.spend(v, g.id, 5.25, V.todayIso(), T0, sync);
  const g2 = V.saveGiftcard(v, { name: "G2", profiles: ["p2"] }, T0, sync);
  const a2 = V.saveAccount(v, { name: "B", profiles: ["p2"] }, T0, sync);
  V.deleteItem(v, "giftcard", g2.id, T0, sync);
  V.deleteItem(v, "account", a2.id, T0, sync);

  const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const okImg = (x) => x === null || (typeof x === "string" && x.startsWith("data:image/"));
  const okAmount = (x, pos) => typeof x === "number" && Number.isFinite(x) && x >= 0 && (!pos || x > 0);
  assert.deepEqual(Object.keys(v).sort(), ["accounts", "bankcards", "deleted", "giftcards", "loyaltycards", "profiles", "version"]);
  const ids = new Set();
  for (const x of v.accounts) {
    assert.match(x.updated, TS);
    assert.match(x.created, TS);
    assert.ok(x.id && x.name && okImg(x.image));
    assert.equal(typeof x.favorite, "boolean");
    assert.ok(Array.isArray(x.profiles) && x.profiles.every((p) => typeof p === "string"));
    for (const k of ["category", "login", "password"]) assert.equal(typeof x[k], "string");
    for (const k of ["login_mask", "password_mask"]) assert.ok(x[k] === null || typeof x[k] === "string");
    assert.ok(!ids.has(x.id));
    ids.add(x.id);
  }
  for (const x of v.giftcards) {
    assert.match(x.updated, TS);
    assert.ok(x.end_date === null || DAY.test(x.end_date));
    assert.ok(okImg(x.image));
    assert.ok(x.initial === null || okAmount(x.initial));
    assert.ok(okAmount(x.remaining));
    for (const h of x.history) {
      assert.deepEqual(Object.keys(h).sort(), ["amount", "date", "id"]);
      assert.match(h.date, DAY);
      assert.ok(h.id && okAmount(h.amount, true));
    }
  }
  assert.equal(v.deleted.length, 2);
  for (const t of v.deleted) {
    assert.deepEqual(Object.keys(t).sort(), ["at", "id", "kind"]);
    assert.match(t.at, TS);
    assert.ok(["account", "giftcard"].includes(t.kind));
  }
});

test("cartes bancaires : enregistrement, expiration normalisée, liste par profil, suppression", () => {
  const v = base();
  const sync = "2026-10-19T10:03:00";
  const b = V.saveBankcard(v, { name: " Boursorama ", holder: "  JULES   C ", number: "4970  1234 5678 1234",
    expiry: "1228", cvv: " 123 ", pin: "4321", profiles: ["p1"] }, T0, sync);
  assert.deepEqual(
    { name: b.name, holder: b.holder, number: b.number, expiry: b.expiry, cvv: b.cvv, pin: b.pin, image: b.image },
    { name: "Boursorama", holder: "JULES C", number: "4970 1234 5678 1234", expiry: "12/28", cvv: "123", pin: "4321", image: null });
  assert.ok(b.updated > sync); // horodatée après la dernière synchro
  assert.deepEqual(Object.keys(b).sort(),
    ["cvv", "expiry", "holder", "id", "image", "name", "number", "pin", "profiles", "updated"]);
  V.saveBankcard(v, { name: "Revolut", profiles: ["p2"] }, T0, sync);
  assert.deepEqual(V.listBankcards(v, "p1").map((x) => x.name), ["Boursorama"]);
  assert.deepEqual(V.listBankcards(v, null).map((x) => x.name), ["Boursorama", "Revolut"]);
  const again = V.saveBankcard(v, { ...b, expiry: "3/2029" }, T0, sync);
  assert.equal(again.id, b.id);
  assert.equal(again.expiry, "03/29");
  assert.equal(v.bankcards.length, 2);
  assert.throws(() => V.saveBankcard(v, { name: "X", expiry: "13/28", profiles: ["p1"] }), /expiration/);
  assert.throws(() => V.saveBankcard(v, { name: " ", profiles: ["p1"] }), /nom/);
  assert.throws(() => V.saveBankcard(v, { name: "X", profiles: [] }), /profil/);
  V.deleteItem(v, "bankcard", b.id, T0, sync);
  assert.deepEqual(v.bankcards.map((x) => x.name), ["Revolut"]);
  assert.deepEqual(v.deleted.map((t) => [t.kind, t.id]), [["bankcard", b.id]]);
});

test("cartes bancaires : coffre d'avant (sans collection) accepté", () => {
  const v = base();
  delete v.bankcards;
  assert.deepEqual(V.listBankcards(v, null), []);
  V.saveBankcard(v, { name: "Boursorama", profiles: ["p1"] });
  assert.equal(v.bankcards.length, 1);
});

test("cartes fidélité : identifiant et PIN facultatifs, liste par profil, suppression", () => {
  const v = base();
  const sync = "2026-10-19T10:03:00";
  const c = V.saveLoyaltycard(v, { name: " Leclerc ", number: " 2912345678901 ", profiles: ["p1", "p2"] }, T0, sync);
  assert.deepEqual({ name: c.name, number: c.number, pin: c.pin, image: c.image }, { name: "Leclerc", number: "2912345678901", pin: "", image: null });
  assert.deepEqual(Object.keys(c).sort(), ["id", "image", "name", "number", "pin", "profiles", "updated"]);
  assert.ok(c.updated > sync);
  V.saveLoyaltycard(v, { name: "Fnac", pin: "12", profiles: ["p2"] }, T0, sync);
  assert.deepEqual(V.listLoyaltycards(v, "p1").map((x) => x.name), ["Leclerc"]);
  assert.deepEqual(V.listLoyaltycards(v, null).map((x) => x.name), ["Fnac", "Leclerc"]);
  assert.throws(() => V.saveLoyaltycard(v, { name: "", profiles: ["p1"] }), /nom/);
  V.deleteItem(v, "loyaltycard", c.id, T0, sync);
  assert.deepEqual(v.loyaltycards.map((x) => x.name), ["Fnac"]);
  assert.equal(v.deleted[0].kind, "loyaltycard");
  const old = base();
  delete old.loyaltycards;
  assert.deepEqual(V.listLoyaltycards(old, null), []);
});
