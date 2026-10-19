// Tests du client de synchro (QR, hello/sync chiffrés, erreurs réseau) et du parcours complet
// avec le PC simulé du natif factice.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("../www/js/crypto.js");
const { parseQr, SyncClient, syncMessage } = require("../www/js/syncclient.js");
const LocalApi = require("../www/js/local-api.js");
const nativeFake = require("../www/js/native-fake.js");

const ITER = 1000; // PBKDF2 réduit pour les tests
const T0 = "2026-10-01T10:00:00";
const FOREIGN = "Ce QR code ne vient pas de Passe-Partout.";

const key = () => crypto.randomBytes(32);
const qrText = (over = {}) =>
  JSON.stringify({ v: 1, hosts: ["10.0.0.1", "192.168.1.20"], port: 8765, key: crypto.b64u(key()), pc: "PC-Jules", ...over });

function info(over = {}) {
  return {
    device_id: "dev-1", device_name: "Pixel", generation: null, last_sync: null, code_version: null,
    has_data: false, now: "2026-10-19T12:00:00", ...over,
  };
}

const HELLO = { ok: true, pc: "PC-Jules", lock_mode: "pin", pin_length: 4, need_code: true, mode: "replace",
  reason: "first", since: null };

// `post` factice : chaque hôte → fonction (msg) → {status, reply?} ou exception (injoignable).
function fakePost(k, hosts, calls = []) {
  return async (url, body, timeoutMs) => {
    const host = new URL(url).hostname;
    calls.push({ url, host, timeoutMs });
    const h = hosts[host];
    if (!h) throw new Error("ECONNREFUSED");
    const msg = await crypto.open(k, body, crypto.AAD_REQ);
    const out = await h(msg);
    if (out.reply === undefined) return { status: out.status, text: out.text || "" };
    return { status: out.status || 200, text: await crypto.seal(out.key || k, out.reply, crypto.AAD_RESP) };
  };
}

test("parseQr valide et refus d'un QR étranger", () => {
  const k = key();
  const q = parseQr(qrText({ key: crypto.b64u(k) }));
  assert.deepEqual(q.hosts, ["10.0.0.1", "192.168.1.20"]);
  assert.equal(q.port, 8765);
  assert.equal(q.pc, "PC-Jules");
  assert.ok(q.key instanceof Uint8Array);
  assert.deepEqual(Array.from(q.key), Array.from(k));
  for (const bad of [
    "https://exemple.fr", "", null, "{}", "[1]",
    qrText({ v: 2 }), qrText({ hosts: [] }), qrText({ hosts: "10.0.0.1" }), qrText({ hosts: [""] }),
    qrText({ key: crypto.b64u(crypto.randomBytes(16)) }), qrText({ key: "!!" }), qrText({ port: 0 }),
    qrText({ port: "80" }), qrText({ port: 70000 }),
  ]) {
    assert.throws(() => parseQr(bad), { message: FOREIGN }, String(bad));
  }
});

test("hello passe au 2e hôte si le 1er ne répond pas", async () => {
  const q = parseQr(qrText());
  const calls = [];
  const seen = [];
  const post = fakePost(q.key, { "192.168.1.20": async (m) => { seen.push(m); return { reply: HELLO }; } }, calls);
  const c = new SyncClient({ qr: q, post, crypto });
  const h = await c.hello(info());
  assert.deepEqual(h, HELLO);
  assert.deepEqual(calls.map((x) => x.host), ["10.0.0.1", "192.168.1.20"]);
  assert.equal(calls[0].url, "http://10.0.0.1:8765/pp-sync");
  assert.ok(calls.every((x) => x.timeoutMs === 3000));
  assert.equal(seen[0].type, "hello");
  assert.equal(seen[0].device_id, "dev-1");
  assert.equal(seen[0].has_data, false);
  // sync suivant : même hôte, sans repasser par le premier ; pas de second hello
  const r = await c.sync({ device_id: "dev-1", code: "1234" }).catch((e) => e);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].host, "192.168.1.20");
  assert.equal(seen[1].type, "sync");
  assert.ok(r); // réponse HELLO renvoyée par le faux PC, peu importe ici
  assert.deepEqual(await c.hello(info()), HELLO);
  assert.equal(calls.length, 3, "un seul hello par session");
});

test("hello : un hôte qui répond mal (autre clé) n'empêche pas le suivant", async () => {
  const q = parseQr(qrText());
  const post = fakePost(q.key, {
    "10.0.0.1": async () => ({ reply: { ok: true }, key: key() }),
    "192.168.1.20": async () => ({ reply: HELLO }),
  });
  const c = new SyncClient({ qr: q, post, crypto });
  assert.equal((await c.hello(info())).pc, "PC-Jules");
});

test("all hosts unreachable", async () => {
  const q = parseQr(qrText());
  const c = new SyncClient({ qr: q, post: fakePost(q.key, {}), crypto });
  await assert.rejects(c.hello(info()), {
    code: "unreachable",
    message: "PC injoignable : vérifie que le téléphone est sur le même Wi-Fi et que le pare-feu Windows autorise Passe-Partout.",
  });
});

test("410 → expired ; 403 → forbidden", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  for (const [status, code, message] of [
    [410, "expired", "QR code expiré : relance la synchronisation sur le PC."],
    [403, "forbidden", "QR code refusé par le PC."],
    [409, "forbidden", "QR code refusé par le PC."],
  ]) {
    const c = new SyncClient({ qr: q, post: fakePost(q.key, { "10.0.0.1": async () => ({ status }) }), crypto });
    await assert.rejects(c.hello(info()), { code, message }, String(status));
  }
});

test("réponse chiffrée avec une autre clé → forbidden", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const post = fakePost(q.key, { "10.0.0.1": async () => ({ reply: HELLO, key: key() }) });
  const c = new SyncClient({ qr: q, post, crypto });
  await assert.rejects(c.hello(info()), { code: "forbidden" });
});

test("réponse valide mais qui n'est pas un objet → forbidden", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const post = fakePost(q.key, { "10.0.0.1": async () => ({ reply: [1, 2] }) });
  await assert.rejects(new SyncClient({ qr: q, post, crypto }).hello(info()), { code: "forbidden" });
});

test("sync : 413 → message « trop volumineuses », coupure → unreachable, « closed » → expired", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  let next = null;
  const post = fakePost(q.key, { "10.0.0.1": async (m) => (m.type === "hello" ? { reply: HELLO } : next(m)) });
  const c = new SyncClient({ qr: q, post, crypto });
  await c.hello(info());
  next = async () => ({ status: 413 });
  await assert.rejects(c.sync({}), (e) => e.code === "unreachable" && /^Données trop volumineuses ou PC injoignable/.test(e.message));
  next = async () => { throw new Error("ECONNRESET"); };
  await assert.rejects(c.sync({}), { code: "unreachable", message: /^PC injoignable/ });
  next = async () => ({ reply: { ok: false, error: "closed", message: "Synchronisation arrêtée sur le PC." } });
  await assert.rejects(c.sync({}), { code: "expired" });
  // erreur du PC ordinaire : renvoyée telle quelle (message affiché par l'écran)
  next = async () => ({ reply: { ok: false, error: "bad_code", message: "Code incorrect.", wait_seconds: 5 } });
  assert.deepEqual(await c.sync({}), { ok: false, error: "bad_code", message: "Code incorrect.", wait_seconds: 5 });
});

test("sync avant hello refusé ; cancel n'échoue jamais", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const seen = [];
  const post = fakePost(q.key, { "10.0.0.1": async (m) => { seen.push(m.type); return { reply: m.type === "hello" ? HELLO : { ok: true } }; } });
  const c = new SyncClient({ qr: q, post, crypto });
  await assert.rejects(c.sync({}));
  await c.cancel(); // rien à annuler : aucun envoi
  assert.deepEqual(seen, []);
  await c.hello(info());
  await c.cancel();
  assert.deepEqual(seen, ["hello", "cancel"]);
  const dead = new SyncClient({ qr: q, post: async () => { throw new Error("x"); }, crypto });
  await dead.cancel();
});

test("syncMessage : last_sync du hello, replace selon le mode, coffre seulement en fusion", () => {
  const i = info({ has_data: true, last_sync: T0, generation: "g1", code_version: "cv1" });
  const vault = { profiles: [], accounts: [], giftcards: [], deleted: [] };
  const r = syncMessage(i, { ...HELLO, mode: "replace" }, { vault, code: "1234", now: "2026-10-19T12:00:05" });
  assert.deepEqual(r, { device_id: "dev-1", device_name: "Pixel", replace: true, last_sync: T0,
    now: "2026-10-19T12:00:05", code: "1234" });
  const m = syncMessage(i, { ...HELLO, mode: "merge", need_code: false }, { vault });
  assert.equal(m.replace, false);
  assert.equal(m.code, null);
  assert.equal(m.now, i.now);
  assert.deepEqual(m.vault, vault);
});

// ---------------------------------------------------------------- parcours complet avec le PC simulé
function pcVault() {
  return {
    profiles: [{ id: "p1", name: "Jules", avatar: null, color: "#ff3d9a", updated: T0 }],
    accounts: [{
      id: "a1", name: "Netflix", category: "Streaming", login: "jules", password: "pw-pc", login_mask: null,
      password_mask: null, image: null, favorite: false, profiles: ["p1"], created: T0, updated: T0,
    }],
    giftcards: [],
    deleted: [],
  };
}

async function runSync(native, api, code) {
  const qr = parseQr(await native.scanQr());
  const c = new SyncClient({ qr, post: (u, b, t) => native.post(u, b, t), crypto });
  const i = await api.sync_info();
  const h = await c.hello(i, { pair: await api.sync_pair() });
  assert.equal(h.ok, true, JSON.stringify(h));
  const payload = await api.sync_payload();
  const vault = h.mode === "merge" ? payload : null;
  const r = await c.sync(syncMessage(i, h, { vault, code }));
  if (r.ok) await api.apply_sync({ ...r, pc: h.pc }, code);
  return { h, r, c };
}

test("parcours complet : téléphone neuf → code du PC → données → fusion sans code", async () => {
  const native = nativeFake.create({ store: nativeFake.memoryStore() });
  const pc = native.simulatePc({ code: "1234", vault: pcVault(), lockMode: "pin", pcName: "PC-Jules" });
  const clk = { now: Date.now() };
  const api = new LocalApi({ native, clock: () => clk.now, iterations: ITER });

  // QR du PC simulé : un premier hôte virtuel injoignable, puis le bon
  const qr = parseQr(await native.scanQr());
  assert.equal(qr.hosts.length, 2);
  assert.equal(qr.pc, "PC-Jules");

  // 1. mauvais code puis bon code, sur la même session (un seul hello)
  const c = new SyncClient({ qr, post: (u, b, t) => native.post(u, b, t), crypto });
  const i = await api.sync_info();
  const h = await c.hello(i);
  assert.equal(h.need_code, true);
  assert.equal(h.mode, "replace");
  assert.equal(h.reason, "first");
  assert.equal(h.lock_mode, "pin");
  assert.equal(h.pin_length, 4);
  assert.ok(!("code_version" in h));
  let r = await c.sync(syncMessage(i, h, { code: null }));
  assert.equal(r.error, "code_required");
  r = await c.sync(syncMessage(i, h, { code: "0000" }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "bad_code");
  assert.equal(typeof r.message, "string");
  r = await c.sync(syncMessage(i, h, { code: "1234" }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.summary, { to_pc: 0, to_phone: 2, deleted: 0, conflicts: 0 });
  assert.equal(typeof r.generation, "string");
  assert.ok(!("pc" in r));
  await api.apply_sync({ ...r, pc: h.pc }, "1234");
  // session à usage unique
  await assert.rejects(c.sync(syncMessage(i, h, { code: "1234" })), { code: "expired" });

  // 2. verrouillé puis déverrouillé avec le code du PC : les données sont là
  await api.lock();
  assert.equal((await api.unlock("0000")).ok, false);
  const st = await api.get_state();
  assert.equal(st.lock_mode, "pin");
  assert.equal(st.pin_length, 4);
  clk.now += 5000; // délai anti-essais écoulé
  assert.equal((await api.unlock("1234")).ok, true);
  assert.deepEqual((await api.list_accounts(null)).map((a) => a.name), ["Netflix"]);

  // 3. fusion : pas de code, la modification du téléphone part vers le PC
  await api.save_account({ name: "Gmail", login: "j@x.fr", password: "pw2", profiles: ["p1"] });
  const second = await runSync(native, api, null);
  assert.equal(second.h.need_code, false);
  assert.equal(second.h.mode, "merge");
  assert.equal(typeof second.h.code_version, "string");
  assert.equal(second.r.ok, true, JSON.stringify(second.r));
  assert.equal(second.r.summary.to_pc, 1);
  assert.deepEqual(pc.vault.accounts.map((a) => a.name).sort(), ["Gmail", "Netflix"]);

  // 4. code du PC changé → redemandé ; le nouveau code déverrouille le téléphone
  pc.setCode("5678");
  const third = await runSync(native, api, "5678");
  assert.equal(third.h.need_code, true);
  assert.equal(third.h.mode, "merge");
  assert.equal(third.r.ok, true);
  await api.lock();
  assert.equal((await api.unlock("5678")).ok, true);

  // 5. PC verrouillé pendant l'affichage du QR → expiré
  const qr4 = parseQr(await native.scanQr());
  pc.lock();
  const c4 = new SyncClient({ qr: qr4, post: (u2, b, t) => native.post(u2, b, t), crypto });
  await assert.rejects(c4.hello(await api.sync_info()), { code: "expired" });
});

// ---------------------------------------------------------------- appairage (Ruling 21)
test("hello appairé : preuve envoyée (jamais le secret), preuve du PC exigée avant tout envoi", async () => {
  const k = key();
  const pair = crypto.b64u(new Uint8Array(32).fill(3));
  const seen = [];
  const pcProof = await crypto.pairProof(crypto.unb64u(pair), k, crypto.PROOF_PC);
  const phoneProof = await crypto.pairProof(crypto.unb64u(pair), k, crypto.PROOF_PHONE);
  const mk = (reply) => new SyncClient({
    qr: parseQr(qrText({ key: crypto.b64u(k), hosts: ["10.0.0.1"] })),
    post: fakePost(k, { "10.0.0.1": async (m) => { seen.push(m); return { reply }; } }), crypto,
  });
  // bon PC : preuve valide
  const ok = mk({ ...HELLO, need_code: false, mode: "merge", proof_pc: pcProof });
  const h = await ok.hello(info({ pair: "ne doit pas partir" }), { pair });
  assert.equal(h.ok, true);
  assert.equal(seen[0].proof, phoneProof);
  assert.ok(!("pair" in seen[0]) && !JSON.stringify(seen[0]).includes(pair));
  // faux PC : pas de preuve, ou preuve fausse → « unpaired », et sync impossible (ni code ni coffre)
  for (const bad of [undefined, "x", phoneProof]) {
    const c = mk({ ...HELLO, proof_pc: bad });
    await assert.rejects(c.hello(info(), { pair }), (e) => e.code === "unpaired" && /Ré-appairer/.test(e.message));
    await assert.rejects(c.sync(syncMessage(info(), HELLO, { code: "1234" })), /hello d'abord/);
  }
  // téléphone sans secret (neuf, corrompu, d'avant l'appairage) : pas de preuve, pas de vérification
  seen.length = 0;
  const fresh = mk({ ...HELLO });
  assert.equal((await fresh.hello(info())).ok, true);
  assert.ok(!("proof" in seen[0]));
});

test("parcours appairé : faux PC refusé avant code et coffre ; PC qui a oublié le téléphone → Ré-appairer", async () => {
  const store = nativeFake.memoryStore();
  const native = nativeFake.create({ store });
  const pc = native.simulatePc({ code: "1234", vault: pcVault(), lockMode: "pin", pcName: "PC-Jules" });
  const api = new LocalApi({ native, clock: () => Date.now(), iterations: ITER });
  const first = await runSync(native, api, "1234");
  assert.equal(typeof first.r.pair, "string");
  assert.equal(await api.sync_pair(), first.r.pair);
  const second = await runSync(native, api, null);
  assert.equal(second.h.need_code, false);
  assert.equal(typeof second.h.proof_pc, "string");

  // faux PC (QR d'un autre « PC ») : refus au hello, il n'a reçu ni code ni coffre
  const forger = nativeFake.create({ store: nativeFake.memoryStore() });
  const fakePc = forger.simulatePc({ code: "0000", vault: pcVault(), lockMode: "pin", pcName: "PC-Jules" });
  const fq = parseQr(await forger.scanQr());
  const fc = new SyncClient({ qr: fq, post: (u, b, t) => forger.post(u, b, t), crypto });
  await assert.rejects(fc.hello(await api.sync_info(), { pair: await api.sync_pair() }), { code: "unpaired" });
  assert.deepEqual(fakePc.log, [{ type: "hello", code: false, vault: false }]);

  // le vrai PC a oublié le téléphone : refus, puis « Ré-appairer » → code demandé, nouveau secret
  pc.forget((await api.sync_info()).device_id);
  const q = parseQr(await native.scanQr());
  const c = new SyncClient({ qr: q, post: (u, b, t) => native.post(u, b, t), crypto });
  await assert.rejects(c.hello(await api.sync_info(), { pair: await api.sync_pair() }), { code: "unpaired" });
  await c.cancel();
  await api.forget_pair();
  const again = await runSync(native, api, "1234");
  assert.equal(again.h.need_code, true);
  assert.equal(again.r.ok, true);
  assert.notEqual(again.r.pair, first.r.pair);
  assert.equal(await api.sync_pair(), again.r.pair);

  // restauration sur le PC : code exigé même avec une preuve valide, puis nouveau secret
  pc.restore();
  const restored = await runSync(native, api, "1234");
  assert.equal(restored.h.need_code, true);
  assert.equal(restored.h.reason, "restored");
  assert.notEqual(restored.r.pair, again.r.pair);
});

test("compareVersions : comparaison numérique des versions x.y.z", () => {
  const { compareVersions } = require("../www/js/syncclient.js");
  assert.strictEqual(compareVersions("1.10.0", "1.9.9"), 1);
  assert.strictEqual(compareVersions("0.1.0", "1.0.0"), -1);
  assert.strictEqual(compareVersions("1.0.0", "1.0.0"), 0);
  assert.throws(() => compareVersions("1.0", "1.0.0"));
  assert.throws(() => compareVersions("1.0.0", "v1.0.0"));
});

test("version.js généré : PPM.VERSION suit le fichier VERSION", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const expected = fs.readFileSync(path.join(__dirname, "..", "..", "VERSION"), "utf8").trim();
  require("../www/js/version.js");
  assert.strictEqual(globalThis.PPM.VERSION, expected);
});

// ------------------------------------------------------------ mise à jour de l'appli (Tâche 5)
const sha256Hex = (bytes) => require("node:crypto").createHash("sha256").update(bytes).digest("hex");
const CORRUPT = "La mise à jour reçue est abîmée : relance la synchronisation.";
const UPDATE_MSG = "Une nouvelle version de l'appli est disponible (0.9.0 → 1.1.0) : mets-la à jour pour synchroniser.";

function updatePc(q, apkBytes, { announced = sha256Hex(apkBytes), sent = announced, seen = [] } = {}) {
  return fakePost(q.key, {
    "10.0.0.1": async (m) => {
      seen.push(m);
      if (m.type === "hello") {
        return { reply: { ok: false, error: "update_required", message: UPDATE_MSG, current: "0.9.0",
          available: "1.1.0", size: apkBytes.length, sha256: announced } };
      }
      if (m.type === "apk") return { reply: { ok: true, apk: crypto.b64u(apkBytes), sha256: sent, version: "1.1.0" } };
      return { reply: { ok: false, error: "invalid", message: "Message de synchronisation invalide." } };
    },
  });
}

test("hello → update_required : Error codée avec les détails, jamais de second hello", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const apk = crypto.randomBytes(1000);
  const seen = [];
  const c = new SyncClient({ qr: q, post: updatePc(q, apk, { seen }), crypto });
  const err = await c.hello(info({ app_version: "0.9.0" })).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(err.code, "update_required");
  assert.equal(err.message, UPDATE_MSG);
  assert.deepEqual(err.details, {
    current: "0.9.0", available: "1.1.0", size: 1000, sha256: sha256Hex(apk), message: UPDATE_MSG,
  });
  assert.equal(seen[0].app_version, "0.9.0");
  await assert.rejects(c.hello(info({ app_version: "0.9.0" })), { code: "update_required" });
  assert.equal(seen.length, 1, "un seul hello par QR");
  await assert.rejects(c.sync({}), /hello d'abord/);
});

test("downloadApk : octets renvoyés quand l'empreinte concorde, délai de 60 s", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const apk = new Uint8Array(require("node:crypto").randomBytes(300000));
  const calls = [];
  const seen = [];
  const post = updatePc(q, apk, { seen });
  const c = new SyncClient({ qr: q, post: (u, b, t) => { calls.push(t); return post(u, b, t); }, crypto });
  await assert.rejects(c.downloadApk()); // pas de mise à jour annoncée
  await assert.rejects(c.hello(info({ app_version: "0.9.0" })), { code: "update_required" });
  const got = await c.downloadApk();
  assert.ok(got instanceof Uint8Array);
  assert.deepEqual(Buffer.from(got), Buffer.from(apk));
  assert.deepEqual(seen.map((m) => m.type), ["hello", "apk"]);
  assert.deepEqual(Object.keys(seen[1]), ["type"]);
  assert.equal(calls[calls.length - 1], 60000);
  // peut être redemandé (téléchargement interrompu) : pas de nouveau hello
  assert.deepEqual(Buffer.from(await c.downloadApk()), Buffer.from(apk));
  assert.deepEqual(seen.map((m) => m.type), ["hello", "apk", "apk"]);
});

test("downloadApk : APK à l'empreinte fausse refusé (apk_corrupt)", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const apk = crypto.randomBytes(5000);
  const other = sha256Hex(crypto.randomBytes(10));
  for (const [what, opts] of [
    ["octets différents de l'empreinte annoncée et reçue", { announced: other, sent: other }],
    ["empreinte reçue différente de celle du hello", { sent: other }],
    ["empreinte du hello différente de celle reçue", { announced: other, sent: sha256Hex(apk) }],
  ]) {
    const c = new SyncClient({ qr: q, post: updatePc(q, apk, opts), crypto });
    await assert.rejects(c.hello(info({ app_version: "0.9.0" })), { code: "update_required" });
    await assert.rejects(c.downloadApk(), { code: "apk_corrupt", message: CORRUPT }, what);
  }
});

test("update_required sans APK sur le PC : sha256 null, rien à télécharger", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const msg = "Mets à jour l'appli : sur le PC, Réglages → Installer l'appli sur le téléphone.";
  const post = fakePost(q.key, { "10.0.0.1": async () => ({ reply: { ok: false, error: "update_required",
    message: msg, current: null, available: "1.1.0", size: null, sha256: null } }) });
  const c = new SyncClient({ qr: q, post, crypto });
  const err = await c.hello(info()).catch((e) => e);
  assert.equal(err.code, "update_required");
  assert.equal(err.details.sha256, null);
  assert.equal(err.details.size, null);
  assert.equal(err.message, msg);
  await assert.rejects(c.downloadApk());
});

test("hello → pc_outdated : Error codée avec le message du PC", async () => {
  const q = parseQr(qrText({ hosts: ["10.0.0.1"] }));
  const post = fakePost(q.key, { "10.0.0.1": async () => ({ reply: { ok: false, error: "pc_outdated",
    message: "Mets à jour Passe-Partout sur le PC (Le Grenier)." } }) });
  const c = new SyncClient({ qr: q, post, crypto });
  await assert.rejects(c.hello(info({ app_version: "2.0.0" })),
    { code: "pc_outdated", message: "Mets à jour Passe-Partout sur le PC (Le Grenier)." });
  await assert.rejects(c.downloadApk());
});

test("PC simulé : téléphone ancien → APK reçu et installé ; sans APK ; PC plus ancien → pc_outdated", async () => {
  require("../www/js/version.js");
  const native = nativeFake.create({ store: nativeFake.memoryStore() });
  const apk = crypto.randomBytes(20000);
  const pc = native.simulatePc({ code: "1234", vault: pcVault(), appVersion: "9.0.0", apk });
  const api = new LocalApi({ native, iterations: ITER });
  const qr = parseQr(await native.scanQr());
  const c = new SyncClient({ qr, post: (u, b, t) => native.post(u, b, t), crypto });
  const err = await c.hello(await api.sync_info()).catch((e) => e);
  assert.equal(err.code, "update_required");
  assert.equal(err.details.current, globalThis.PPM.VERSION);
  assert.equal(err.details.available, "9.0.0");
  assert.equal(err.details.size, apk.length);
  assert.equal(err.details.sha256, sha256Hex(apk));
  await assert.rejects(c.sync({}), /hello d'abord/);
  const bytes = await c.downloadApk();
  await native.installApk(bytes);
  assert.equal(native.installed.length, 1);
  assert.deepEqual(Buffer.from(native.installed[0]), Buffer.from(apk));
  assert.deepEqual(pc.log.map((m) => m.type), ["hello", "apk"]);

  // PC sans APK : pas d'empreinte, « apk » refusé
  native.simulatePc({ code: "1234", appVersion: "9.0.0", apk: null });
  const c2 = new SyncClient({ qr: parseQr(await native.scanQr()), post: (u, b, t) => native.post(u, b, t), crypto });
  const e2 = await c2.hello(await api.sync_info()).catch((e) => e);
  assert.equal(e2.code, "update_required");
  assert.equal(e2.details.sha256, null);

  // PC plus ancien que le téléphone
  native.simulatePc({ code: "1234", appVersion: "0.0.1" });
  const c3 = new SyncClient({ qr: parseQr(await native.scanQr()), post: (u, b, t) => native.post(u, b, t), crypto });
  await assert.rejects(c3.hello(await api.sync_info()),
    { code: "pc_outdated", message: "Mets à jour Passe-Partout sur le PC (Le Grenier)." });

  // même version (défaut) : parcours normal
  native.simulatePc({ code: "1234", vault: pcVault() });
  const ok = await runSync(native, api, "1234");
  assert.equal(ok.r.ok, true);
});
