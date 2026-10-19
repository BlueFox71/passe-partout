// Tests du coffre local du téléphone (LocalApi) avec le natif simulé.
const test = require("node:test");
const assert = require("node:assert");
const LocalApi = require("../www/js/local-api.js");
const nativeFake = require("../www/js/native-fake.js");

const T0 = "2026-10-19T10:00:00";
const SECRET = "S3cret-EnClair!";
const ITER = 1000; // PBKDF2 réduit pour les tests

// Réponse de synchro réussie du PC (forme de SyncFlow._on_sync).
function pcResp(over = {}) {
  return {
    ok: true,
    vault: {
      version: 1,
      profiles: [{ id: "p1", name: "Moi", avatar: null, color: "#ff3d9a", updated: T0 }],
      accounts: [{
        id: "a1", name: "Banque", category: "Finance", login: "jules", password: SECRET,
        login_mask: null, password_mask: null, image: null, favorite: false, profiles: ["p1"],
        created: T0, updated: T0,
      }],
      giftcards: [{
        id: "g1", name: "Fnac", code: "123", pin: "", initial: 50, remaining: 50, end_date: null,
        image: null, profiles: ["p1"], history: [], updated: T0,
      }],
      deleted: [],
    },
    summary: { to_pc: 0, to_phone: 3, deleted: 0, conflicts: 0 },
    code_version: "cv1",
    generation: "gen1",
    synced_at: T0,
    lock_mode: "pin",
    pin_length: 4,
    ...over,
  };
}

function setup(store = nativeFake.memoryStore()) {
  const clk = { now: new Date(2026, 9, 19, 12, 0, 0).getTime() };
  const native = nativeFake.create({ store });
  const api = new LocalApi({ native, clock: () => clk.now, iterations: ITER });
  return { api, native, store, clk };
}

async function synced(code = "1234") {
  const s = setup();
  await s.api.apply_sync(pcResp(), code);
  return s;
}

test("avant la première synchro : pas de données, pas verrouillé", async () => {
  const { api } = setup();
  const s = await api.get_state();
  assert.equal(s.has_data, false);
  assert.equal(s.locked, false);
  assert.equal(s.corrupt, false);
  assert.equal(s.lock_mode, "none");
  assert.deepEqual(s.profiles, []);
  assert.equal(s.biometric, false);
  const info = await api.sync_info();
  assert.match(info.device_id, /^[0-9a-f]{32}$/);
  assert.equal(info.has_data, false);
  assert.equal(info.generation, null);
  assert.equal(info.last_sync, null);
  assert.equal(info.code_version, null);
  assert.equal(typeof info.device_name, "string");
  assert.equal(info.now, "2026-10-19T12:00:00");
  assert.deepEqual(await api.sync_payload(), { profiles: [], accounts: [], giftcards: [], deleted: [] });
});

test("device_id créé une fois et conservé", async () => {
  const { api, store } = setup();
  const id = (await api.sync_info()).device_id;
  const again = setup(store).api;
  assert.equal((await again.sync_info()).device_id, id);
});

test("après apply_sync(premier, '1234') : unlock('1234') ok, unlock('0000') refusé", async () => {
  const { api, clk } = await synced();
  let s = await api.get_state();
  assert.equal(s.has_data, true);
  assert.equal(s.locked, false);
  assert.equal(s.lock_mode, "pin");
  assert.equal(s.pin_length, 4);
  assert.equal(s.profiles.length, 1);
  await api.lock();
  assert.equal((await api.get_state()).locked, true);
  assert.deepEqual(await api.unlock("0000"), { ok: false, wait_seconds: 1, error: "bad_code" });
  clk.now += 1000;
  assert.deepEqual(await api.unlock("1234"), { ok: true, wait_seconds: 0 });
  s = await api.get_state();
  assert.equal(s.locked, false);
  const accs = await api.list_accounts(null);
  assert.equal(accs[0].password, SECRET);
  const info = await api.sync_info();
  assert.equal(info.generation, "gen1");
  assert.equal(info.code_version, "cv1");
  assert.equal(info.last_sync, T0);
  assert.equal(info.has_data, true);
});

test("délai anti-essais : 1 s puis 2 s, conservé par une nouvelle instance sur les mêmes préférences", async () => {
  const { api, store, clk } = await synced();
  await api.lock();
  assert.deepEqual(await api.unlock("0000"), { ok: false, wait_seconds: 1, error: "bad_code" });
  // pendant l'attente, même le bon code est refusé sans être essayé : « wait » (un code essayé et faux : « bad_code »)
  assert.deepEqual(await api.unlock("1234"), { ok: false, wait_seconds: 1, error: "wait" });
  clk.now += 1000;
  assert.deepEqual(await api.unlock("9999"), { ok: false, wait_seconds: 2, error: "bad_code" });
  // « redémarrage » de l'appli : nouvelle instance, mêmes préférences
  const native2 = nativeFake.create({ store });
  const api2 = new LocalApi({ native: native2, clock: () => clk.now, iterations: ITER });
  assert.equal((await api2.get_state()).locked, true);
  assert.deepEqual(await api2.unlock("1234"), { ok: false, wait_seconds: 2, error: "wait" });
  clk.now += 2000;
  assert.deepEqual(await api2.unlock("1234"), { ok: true, wait_seconds: 0 });
  assert.deepEqual(await native2.getPref("pp.lockout"), { fails: 0, until: 0 });
});

test("vault.enc ne contient pas le mot de passe en clair", async () => {
  const { native } = await synced();
  const raw = await native.readFile("vault.enc");
  assert.ok(raw && raw.length > 0);
  assert.ok(!raw.includes(SECRET));
  assert.ok(!raw.includes("jules"));
  const keys = JSON.parse(await native.readFile("keys.json"));
  // la clé protégée par le code passe aussi par le Keystore (blob du natif, pas le JSON en clair)
  assert.equal(typeof keys.code, "string");
  assert.ok(!keys.code.includes("salt"));
  assert.ok(nativeFake.isFakeBlob(keys.code, "pp-device"));
  assert.equal(keys.bio, undefined);
});

test("lock() : list_accounts lève « Coffre verrouillé »", async () => {
  const { api } = await synced();
  await api.lock();
  for (const call of [
    () => api.list_accounts(null), () => api.list_giftcards(null), () => api.get_settings(),
    () => api.save_account({ name: "X", profiles: ["p1"] }), () => api.delete_account("a1"),
    () => api.spend("g1", 1), () => api.sync_payload(),
  ]) {
    await assert.rejects(call(), (e) => e instanceof Error && e.message === "Coffre verrouillé");
  }
  const s = await api.get_state();
  assert.deepEqual(s.profiles, []);
});

test("empreinte : activée puis unlock_biometric ok ; KEY_INVALIDATED → biometric désactivé, error 'bio_invalidated'", async () => {
  const { api, native } = await synced();
  assert.deepEqual(await api.get_settings(), { autolock_minutes: 5, biometric: false });
  const st = await api.save_settings({ biometric: true });
  assert.equal(st.biometric, true);
  const keys = JSON.parse(await native.readFile("keys.json"));
  assert.ok(nativeFake.isFakeBlob(keys.bio, "pp-bio"));
  assert.equal((await api.get_state()).biometric, true);

  await api.lock();
  assert.deepEqual(await api.unlock_biometric(), { ok: true });
  assert.equal((await api.list_accounts(null)).length, 1);

  await api.lock();
  native.setBiometricError("CANCELED");
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "canceled" });
  assert.equal((await api.get_state()).biometric, true); // annuler ne désactive rien

  native.setBiometricError("KEY_INVALIDATED");
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "bio_invalidated" });
  const s = await api.get_state();
  assert.equal(s.biometric, false);
  assert.equal(s.locked, true);
  assert.equal(JSON.parse(await native.readFile("keys.json")).bio, undefined);
  // le code marche toujours
  assert.equal((await api.unlock("1234")).ok, true);
  assert.equal((await api.get_settings()).biometric, false);
});

test("save_settings : délai de verrouillage et désactivation de l'empreinte", async () => {
  const { api, native } = await synced();
  assert.equal((await api.save_settings({ autolock_minutes: "10" })).autolock_minutes, 10);
  await api.save_settings({ biometric: true });
  assert.deepEqual(await api.save_settings({ biometric: false }), { autolock_minutes: 10, biometric: false });
  assert.equal(JSON.parse(await native.readFile("keys.json")).bio, undefined);
  native.setBiometricAvailable(false);
  await assert.rejects(api.save_settings({ biometric: true }), /empreinte/i);
});

test("code changé sur le PC : apply_sync(resp, '5678') → nouveau code ok, ancien refusé, données intactes", async () => {
  const { api, clk } = await synced();
  await api.save_account({ name: "Mail", login: "j@x.fr", password: "pw2", profiles: ["p1"] });
  const payload = await api.sync_payload();
  const resp = pcResp({
    code_version: "cv2", synced_at: "2026-10-19T12:00:00", lock_mode: "password", pin_length: null,
  });
  resp.vault.accounts = payload.accounts;
  await api.apply_sync(resp, "5678");
  assert.equal((await api.sync_info()).code_version, "cv2");
  const st = await api.get_state();
  assert.equal(st.lock_mode, "password");
  assert.equal(st.pin_length, null);
  await api.lock();
  assert.equal((await api.unlock("1234")).ok, false);
  clk.now += 1000;
  assert.equal((await api.unlock("5678")).ok, true);
  const names = (await api.list_accounts(null)).map((a) => a.name);
  assert.deepEqual(names, ["Banque", "Mail"]);
});

test("apply_sync sans code garde le code ; lock_mode inconnu accepté", async () => {
  const { api } = await synced();
  await api.apply_sync(pcResp({ lock_mode: "unknown", pin_length: null, generation: null }), null);
  const st = await api.get_state();
  assert.equal(st.lock_mode, "unknown");
  assert.equal((await api.sync_info()).generation, null);
  await api.lock();
  assert.equal((await api.unlock("1234")).ok, true);
});

test("apply_sync : premier lancement sans code refusé, réponse invalide refusée", async () => {
  const { api } = setup();
  await assert.rejects(api.apply_sync(pcResp(), null), /code/i);
  await assert.rejects(api.apply_sync({ ok: true, vault: null }, "1234"), /invalide/i);
  assert.equal((await api.get_state()).has_data, false);
});

test("apply_sync écrit vault.enc, puis keys.json, puis pp.meta", async () => {
  const { api, native } = setup();
  const order = [];
  const wf = native.writeFileAtomic.bind(native);
  const sp = native.setPref.bind(native);
  native.writeFileAtomic = async (name, text) => { order.push(name); return wf(name, text); };
  native.setPref = async (key, value) => { order.push(key); return sp(key, value); };
  await api.sync_info(); // crée le device_id avant la synchro
  order.length = 0;
  await api.apply_sync(pcResp(), "1234");
  assert.deepEqual(order.filter((x) => ["vault.enc", "keys.json", "pp.meta"].includes(x)),
    ["vault.enc", "keys.json", "pp.meta"]);
});

test("delete_account puis sync_payload contient la pierre tombale", async () => {
  const { api } = await synced();
  await api.delete_account("a1");
  const p = await api.sync_payload();
  assert.deepEqual(Object.keys(p).sort(), ["accounts", "deleted", "giftcards", "profiles"]);
  assert.equal(p.accounts.length, 0);
  assert.equal(p.deleted.length, 1);
  assert.equal(p.deleted[0].kind, "account");
  assert.equal(p.deleted[0].id, "a1");
  // daté après la dernière synchro (contrat d'horodatage)
  assert.ok(p.deleted[0].at > T0);
});

test("modifications : horodatées après last_sync et réécrites dans vault.enc", async () => {
  const { api, native, clk } = await synced();
  clk.now = new Date(2026, 9, 19, 9, 0, 0).getTime(); // horloge du téléphone en retard sur le PC
  const before = await native.readFile("vault.enc");
  const a = await api.save_account({ id: "a1", name: "Banque 2", password: "x", profiles: ["p1"] });
  assert.equal(a.updated, "2026-10-19T10:00:01");
  assert.notEqual(await native.readFile("vault.enc"), before);
  const g = await api.spend("g1", 12.5);
  assert.equal(g.remaining, 37.5);
  assert.equal(g.history[0].date, "2026-10-19");
  assert.equal(g.updated, "2026-10-19T10:00:01");
  await api.save_giftcard({ name: "Cadhoc", remaining: 20, profiles: ["p1"] });
  await api.delete_giftcard("g1");
  // relu depuis le disque par une nouvelle instance
  const { store } = native;
  const api2 = new LocalApi({ native: nativeFake.create({ store }), clock: () => clk.now, iterations: ITER });
  assert.equal((await api2.unlock("1234")).ok, true);
  assert.equal((await api2.list_accounts(null))[0].name, "Banque 2");
  assert.deepEqual((await api2.list_giftcards(null)).map((x) => x.name), ["Cadhoc"]);
  // la liste renvoyée est une copie : la modifier ne touche pas le coffre
  (await api2.list_accounts(null))[0].name = "zz";
  assert.equal((await api2.list_accounts(null))[0].name, "Banque 2");
});

test("erreurs de validation en français", async () => {
  const { api } = await synced();
  await assert.rejects(api.save_account({ name: " ", profiles: ["p1"] }), /Le nom est obligatoire/);
  await assert.rejects(api.spend("g1", 999), /Montant supérieur au solde restant/);
});

test("copy_secret / copy_plain passent par le natif", async () => {
  const { api, native } = await synced();
  assert.deepEqual(await api.copy_secret("pw"), {});
  assert.deepEqual(native.clipboard, { text: "pw", sensitive: true });
  await api.copy_plain("login");
  assert.deepEqual(native.clipboard, { text: "login", sensitive: false });
});

test("copy_secret laisse le texte dans le presse-papiers (aucun effacement programmé)", async () => {
  const { api, native } = await synced();
  const realSetTimeout = global.setTimeout;
  let timers = 0;
  global.setTimeout = (...a) => { timers++; return realSetTimeout(...a); };
  try {
    await api.copy_secret("pw");
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.equal(timers, 0);
  assert.equal(native.clipboard.text, "pw");
  assert.equal(native.clipboard.sensitive, true);
});

test("nativeFake : wrap réversible mais pas identité ; deleteKey rend l'ancien blob illisible", async () => {
  const n = nativeFake.create();
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const blob = await n.wrap("pp-device", bytes);
  assert.equal(typeof blob, "string");
  assert.ok(nativeFake.isFakeBlob(blob, "pp-device"));
  assert.deepEqual(await n.unwrap("pp-device", blob), bytes);
  await assert.rejects(n.unwrap("pp-autre", blob), { code: "BAD_BLOB" });
  await assert.rejects(n.unwrap("pp-device", "pas un blob"), { code: "BAD_BLOB" });
  await n.deleteKey("pp-device");
  await assert.rejects(n.unwrap("pp-device", blob), { code: "KEY_MISSING" });
  await n.wrap("pp-device", bytes); // nouvelle clé : l'ancien blob reste illisible
  await assert.rejects(n.unwrap("pp-device", blob), { code: "BAD_BLOB" });
  assert.equal(await n.readFile("absent"), null);
  assert.equal(await n.getPref("absent"), null);
  assert.equal(await n.scanQr(), null);
  n.setNextQr("pp://x");
  assert.equal(await n.scanQr(), "pp://x");
});

// ---------------------------------------------------------------- correctifs de revue (tour 1)
test("apply_sync refuse ok:false et les éléments invalides sans rien écrire", async () => {
  const { api, native } = await synced();
  const before = await native.readFile("vault.enc");
  const keysBefore = await native.readFile("keys.json");
  const metaBefore = await native.getPref("pp.meta");
  const bad = [
    pcResp({ ok: false }),
    (() => { const r = pcResp(); delete r.ok; return r; })(),
    (() => { const r = pcResp(); r.vault.accounts = [null, 42, { foo: 1 }]; return r; })(),
    (() => { const r = pcResp(); r.vault.accounts[0].updated = "hier"; return r; })(),
    (() => { const r = pcResp(); r.vault.accounts[0].profiles = "p1"; return r; })(),
    (() => { const r = pcResp(); r.vault.accounts.push({ ...r.vault.accounts[0] }); return r; })(),
    (() => { const r = pcResp(); r.vault.giftcards[0].remaining = -1; return r; })(),
    (() => { const r = pcResp(); r.vault.giftcards[0].history = [{ id: "h", date: "2026-02-30", amount: 1 }]; return r; })(),
    (() => { const r = pcResp(); r.vault.deleted = [{ kind: "account", id: "x", at: T0, extra: 1 }]; return r; })(),
    (() => { const r = pcResp(); r.vault.deleted = [{ kind: "chose", id: "x", at: T0 }]; return r; })(),
    (() => { const r = pcResp(); r.vault.profiles[0].avatar = "http://x"; return r; })(),
  ];
  for (const r of bad) {
    await assert.rejects(api.apply_sync(r, "5678"), /Réponse de synchronisation invalide/);
  }
  assert.equal(await native.readFile("vault.enc"), before);
  assert.equal(await native.readFile("keys.json"), keysBefore);
  assert.deepEqual(await native.getPref("pp.meta"), metaBefore);
  assert.equal((await api.list_accounts(null))[0].password, SECRET);
});

test("clé du Keystore perdue → état corrompu → resynchro avec le code → unlock avec ce code", async () => {
  const { api, native, store, clk } = await synced();
  await api.save_settings({ biometric: true });
  await api.lock();
  await native.deleteKey("pp-device");
  assert.deepEqual(await api.unlock("1234"), { ok: false, wait_seconds: 0, error: "corrupt" });
  const s = await api.get_state();
  assert.equal(s.corrupt, true);
  assert.equal(s.locked, false);
  assert.equal(s.has_data, false);
  assert.equal(s.lock_mode, "none");
  assert.equal(s.biometric, false);
  const info = await api.sync_info();
  assert.equal(info.has_data, false);
  assert.equal(info.code_version, null);
  assert.equal(info.generation, null);
  assert.equal(info.last_sync, null);
  assert.deepEqual(await api.sync_payload(), { profiles: [], accounts: [], giftcards: [], deleted: [] });
  await assert.rejects(api.apply_sync(pcResp(), null), /code/i);
  // le PC exige le code et remplace
  await api.apply_sync(pcResp({ synced_at: "2026-10-19T12:00:00" }), "4321");
  const s2 = await api.get_state();
  assert.equal(s2.corrupt, false);
  assert.equal(s2.has_data, true);
  assert.equal(s2.locked, false);
  await api.lock();
  assert.equal((await api.unlock("1234")).error, "bad_code");
  clk.now += 1000;
  assert.equal((await api.unlock("4321")).ok, true);
  assert.equal((await api.list_accounts(null))[0].password, SECRET);
  // et après un redémarrage
  const api2 = new LocalApi({ native: nativeFake.create({ store }), clock: () => clk.now, iterations: ITER });
  assert.equal((await api2.get_state()).corrupt, false);
  assert.equal((await api2.unlock("4321")).ok, true);
});

test("un mauvais code reste « bad_code », jamais « corrupt » ; vault.enc abîmé → corrupt avec le bon code", async () => {
  const { api, native, clk } = await synced();
  await api.lock();
  const vaultBefore = await native.readFile("vault.enc");
  for (const code of ["0000", "9999", "", "abc"]) {
    clk.now += 400000;
    const r = await api.unlock(code);
    assert.equal(r.error, "bad_code");
    assert.equal((await api.get_state()).corrupt, false);
  }
  assert.equal(await native.readFile("vault.enc"), vaultBefore);
  // vault.enc abîmé : un mauvais code reste un mauvais code…
  const blob = JSON.parse(vaultBefore);
  blob.ct = blob.ct.slice(0, -4) + (blob.ct.endsWith("AAAA") ? "BBBB" : "AAAA");
  await native.writeFileAtomic("vault.enc", JSON.stringify(blob));
  clk.now += 400000;
  assert.equal((await api.unlock("0000")).error, "bad_code");
  assert.equal((await api.get_state()).corrupt, false);
  // … le bon code révèle la corruption
  clk.now += 400000;
  assert.deepEqual(await api.unlock("1234"), { ok: false, wait_seconds: 0, error: "corrupt" });
  assert.equal((await api.get_state()).corrupt, true);
});

test("fichiers incomplets ou illisibles au démarrage → corrompu ; aucun fichier → neuf", async () => {
  for (const [keys, vault] of [[null, "{}"], ["{}", null], ["pas du json", "{}"], ['{"code":"x"}', "pas du json"]]) {
    const store = nativeFake.memoryStore();
    const n = nativeFake.create({ store });
    if (keys !== null) await n.writeFileAtomic("keys.json", keys);
    if (vault !== null) await n.writeFileAtomic("vault.enc", vault);
    await n.setPref("pp.meta", { device_id: "d", last_sync: T0 }); // déjà synchronisé une fois
    const api = new LocalApi({ native: n, clock: () => 0, iterations: ITER });
    const s = await api.get_state();
    assert.deepEqual([s.corrupt, s.locked, s.has_data], [true, false, false], `${keys} / ${vault}`);
    await api.apply_sync(pcResp(), "1234");
    assert.equal((await api.get_state()).corrupt, false);
  }
  const fresh = setup().api;
  assert.equal((await fresh.get_state()).corrupt, false);
});

test("empreinte : vault.enc illisible → corrupt", async () => {
  const { api, native } = await synced();
  await api.save_settings({ biometric: true });
  await api.lock();
  await native.writeFileAtomic("vault.enc", JSON.stringify({ v: 1, iv: "AAAA", ct: "AAAA" }));
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "corrupt" });
  assert.equal((await api.get_state()).corrupt, true);
});

test("verify_code : mêmes règles que unlock, sans verrouiller ; sync_info donne le nom du PC", async () => {
  const { api, clk } = setup();
  await api.apply_sync(pcResp({ pc: "PC-Salon" }), "1234");
  assert.deepEqual(await api.verify_code("0000"), { ok: false, wait_seconds: 1, error: "bad_code" });
  assert.deepEqual(await api.verify_code("1234"), { ok: false, wait_seconds: 1, error: "wait" });
  clk.now += 1000;
  assert.deepEqual(await api.verify_code("1234"), { ok: true, wait_seconds: 0 });
  assert.equal((await api.get_state()).locked, false);
  assert.equal((await api.sync_info()).pc_name, "PC-Salon");
});

// ---------------------------------------------------------------- erreurs du Keystore distinguées
test("clé du code : erreur passagère du Keystore → « native », réessayable, rien de marqué ni compté", async () => {
  for (const code of ["FAILED", "KEY_INVALIDATED", "CANCELED", undefined]) {
    const { api, native } = await synced();
    await api.lock();
    native.setUnwrapError(code || "SANS_CODE");
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await api.unlock("1234"), { ok: false, wait_seconds: 0, error: "native" }, String(code));
    }
    assert.deepEqual(await api.verify_code("1234"), { ok: false, wait_seconds: 0, error: "native" });
    const s = await api.get_state();
    assert.deepEqual([s.corrupt, s.locked, s.has_data], [false, true, true]);
    native.setUnwrapError(null);
    // aucun délai anti-essais : le bon code passe tout de suite
    assert.deepEqual(await api.unlock("1234"), { ok: true, wait_seconds: 0 });
  }
});

test("clé du code : KEY_MISSING ou blob illisible → corrompu", async () => {
  {
    const { api, native } = await synced();
    await api.lock();
    native.setUnwrapError("KEY_MISSING");
    assert.deepEqual(await api.unlock("1234"), { ok: false, wait_seconds: 0, error: "corrupt" });
    assert.equal((await api.get_state()).corrupt, true);
  }
  {
    const { api, native } = await synced();
    await api.lock();
    const keys = JSON.parse(await native.readFile("keys.json"));
    keys.code = "abîmé";
    await native.writeFileAtomic("keys.json", JSON.stringify(keys));
    const api2 = new LocalApi({ native, clock: () => 0, iterations: ITER });
    assert.deepEqual(await api2.verify_code("1234"), { ok: false, wait_seconds: 0, error: "corrupt" });
    assert.equal((await api2.get_state()).corrupt, true);
  }
});

test("empreinte : erreur passagère → « native », empreinte gardée ; clé effacée → désactivée", async () => {
  const { api, native } = await synced();
  await api.save_settings({ biometric: true });
  await api.lock();
  native.setBiometricError("FAILED");
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "native" });
  assert.equal((await api.get_state()).biometric, true);
  native.setBiometricError(null);
  assert.deepEqual(await api.unlock_biometric(), { ok: true });
  await api.lock();
  await native.deleteKey("pp-bio");
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "bio_invalidated" });
  const s = await api.get_state();
  assert.deepEqual([s.biometric, s.corrupt, s.locked], [false, false, true]);
  assert.equal((await api.unlock("1234")).ok, true);
});

test("nativeFake : bouton retour essayé du dernier rappel au premier", async () => {
  const n = nativeFake.create();
  assert.equal(await n.fireBack(), false);
  const seen = [];
  n.onBack(() => { seen.push("a"); return true; });
  n.onBack(() => { seen.push("b"); return false; });
  assert.equal(await n.fireBack(), true);
  assert.deepEqual(seen, ["b", "a"]);
});

// ---------------------------------------------------------------- revue finale mobile
const PAIR = crypto_b64u(new Uint8Array(32).fill(9));
function crypto_b64u(b) { return require("../www/js/crypto.js").b64u(b); }

test("première synchro interrompue (aucune synchro réussie) → téléphone neuf, pas « corrompu »", async () => {
  for (const [keys, vault] of [[null, '{"v":1,"iv":"x","ct":"y"}'], ["{}", null]]) {
    const n = nativeFake.create({ store: nativeFake.memoryStore() });
    if (keys !== null) await n.writeFileAtomic("keys.json", keys);
    if (vault !== null) await n.writeFileAtomic("vault.enc", vault);
    const api = new LocalApi({ native: n, clock: () => 0, iterations: ITER });
    const s = await api.get_state();
    assert.deepEqual([s.corrupt, s.locked, s.has_data], [false, false, false]);
    await api.apply_sync(pcResp(), "1234");
    const st = await api.get_state();
    assert.equal(st.has_data, true);
    assert.equal((await api.list_accounts(null)).length, 1);
  }
});

test("appairage : secret reçu gardé chiffré dans vault.enc, jamais en préférences ni dans le coffre envoyé", async () => {
  const { api, store, native } = setup();
  assert.equal(await api.sync_pair(), null);
  await api.apply_sync(pcResp({ pair: PAIR }), "1234");
  assert.equal(await api.sync_pair(), PAIR);
  const prefs = JSON.stringify(await native.getPref("pp.meta")) + JSON.stringify(await native.getPref("pp.settings"));
  assert.ok(!prefs.includes(PAIR));
  assert.ok(!(await native.readFile("vault.enc")).includes(PAIR));
  assert.ok(!JSON.stringify(await api.sync_payload()).includes(PAIR));
  assert.ok(!JSON.stringify(await api.sync_info()).includes(PAIR));
  // synchro suivante sans nouveau secret : l'ancien est gardé ; relu après redémarrage
  await api.apply_sync(pcResp({ synced_at: "2026-10-19T11:00:00" }));
  const again = new LocalApi({ native: nativeFake.create({ store }), clock: () => 0, iterations: ITER });
  assert.equal((await again.unlock("1234")).ok, true);
  assert.equal(await again.sync_pair(), PAIR);
  // « Ré-appairer » : secret oublié
  assert.deepEqual(await again.forget_pair(), {});
  assert.equal(await again.sync_pair(), null);
  // secret mal formé refusé sans rien écrire
  await assert.rejects(again.apply_sync(pcResp({ pair: "court" })), /invalide/);
});

test("Ruling 22 : coffre modifié pendant la synchro → apply_sync ne remplace rien, last_sync inchangé", async () => {
  const { api, native } = await synced();
  const before = (await api.sync_info()).last_sync;
  await api.sync_payload();
  await api.save_account({ name: "Ajout pendant la synchro", login: "x", password: "y", profiles: ["p1"] });
  const r = await api.apply_sync(pcResp({ synced_at: "2026-10-19T11:00:00" }));
  assert.deepEqual(r, { error: "modified" });
  assert.equal((await api.sync_info()).last_sync, before);
  assert.ok((await api.list_accounts(null)).some((a) => a.name === "Ajout pendant la synchro"));
  assert.equal((await native.getPref("pp.meta")).last_sync, before);
  // relance : sync_payload puis apply_sync sans modification → appliqué
  await api.sync_payload();
  assert.deepEqual(await api.apply_sync(pcResp({ synced_at: "2026-10-19T11:00:00" })), {});
  assert.equal((await api.sync_info()).last_sync, "2026-10-19T11:00:00");
});

test("coffre modifié pendant la synchro : le secret d'appairage tourné est quand même gardé (chiffré), rien d'autre", async () => {
  const { api, store, native } = await synced();
  await api.apply_sync(pcResp({ pair: PAIR }));
  const PAIR2 = Buffer.alloc(32, 7).toString("base64url");
  assert.notEqual(PAIR2, PAIR);
  const before = (await api.sync_info()).last_sync;
  await api.sync_payload();
  await api.save_account({ name: "Ajout pendant la synchro", login: "x", password: "y", profiles: ["p1"] });
  const r = await api.apply_sync(pcResp({ pair: PAIR2, synced_at: "2026-10-19T11:00:00" }));
  assert.deepEqual(r, { error: "modified" });
  assert.equal(await api.sync_pair(), PAIR2);
  assert.equal((await api.sync_info()).last_sync, before);
  assert.ok((await api.list_accounts(null)).some((a) => a.name === "Ajout pendant la synchro"));
  const prefs = JSON.stringify(await native.getPref("pp.meta")) + JSON.stringify(await native.getPref("pp.settings"));
  assert.ok(!prefs.includes(PAIR2));
  assert.ok(!(await native.readFile("vault.enc")).includes(PAIR2));
  // relu après redémarrage
  const again = new LocalApi({ native: nativeFake.create({ store }), clock: () => 0, iterations: ITER });
  assert.equal((await again.unlock("1234")).ok, true);
  assert.equal(await again.sync_pair(), PAIR2);
  assert.ok((await again.list_accounts(null)).some((a) => a.name === "Ajout pendant la synchro"));
});

test("empreinte : trop d'essais (LOCKOUT) → « bio_lockout », empreinte gardée", async () => {
  const { api, native } = await synced();
  await api.save_settings({ biometric: true });
  await api.lock();
  native.setBiometricError("LOCKOUT");
  assert.deepEqual(await api.unlock_biometric(), { ok: false, error: "bio_lockout" });
  native.setBiometricError(null);
  assert.equal((await api.get_state()).biometric, true);
  assert.equal((await api.unlock_biometric()).ok, true);
});

test("nativeFake : écran natif (empreinte, scanner) signalé pendant l'appel (Ruling 23)", async () => {
  const native = nativeFake.create({ store: nativeFake.memoryStore() });
  assert.equal(native.inNativeScreen(), false);
  const blob = await native.wrap("pp-bio", new Uint8Array([1, 2]), { biometric: true });
  const p = native.unwrap("pp-bio", blob, { title: "x" });
  assert.equal(native.inNativeScreen(), true);
  await p;
  assert.equal(native.inNativeScreen(), false);
  native.setNextQr("qr");
  const q = native.scanQr();
  assert.equal(native.inNativeScreen(), true);
  assert.equal(await q, "qr");
  assert.equal(native.inNativeScreen(), false);
});

test("sync_info envoie la version de l'appli (PPM.VERSION)", async () => {
  require("../www/js/version.js");
  const { api } = setup();
  const info = await api.sync_info();
  assert.equal(typeof globalThis.PPM.VERSION, "string");
  assert.strictEqual(info.app_version, globalThis.PPM.VERSION);
});

test("nativeFake : installApk enregistre les octets, écran natif pendant l'appel, refus simulable", async () => {
  const native = nativeFake.create({ store: nativeFake.memoryStore() });
  assert.deepEqual(native.installed, []);
  const bytes = new Uint8Array([80, 75, 3, 4, 9]);
  const p = native.installApk(bytes);
  assert.equal(native.inNativeScreen(), true);
  await p;
  assert.equal(native.inNativeScreen(), false);
  assert.deepEqual(Array.from(native.installed[0]), [80, 75, 3, 4, 9]);
  bytes[0] = 0; // copie gardée, pas une référence
  assert.equal(native.installed[0][0], 80);
  native.setInstallError("INSTALL_PERMISSION");
  await assert.rejects(native.installApk(bytes), { code: "INSTALL_PERMISSION" });
  assert.equal(native.installed.length, 1);
  native.setInstallError(null);
  await native.installApk(bytes);
  assert.equal(native.installed.length, 2);
});
