// Intégration réelle PC ↔ téléphone : le vrai PC Python (app/api.py + SyncServer sur 127.0.0.1, via
// test/pc_server.py) face à local-api.js + syncclient.js (natif simulé, requêtes HTTP réelles).
// Ignoré, avec un message, si l'environnement Python du dépôt (.venv) est absent.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const crypto = require("../www/js/crypto.js");
const LocalApi = require("../www/js/local-api.js");
const nativeFake = require("../www/js/native-fake.js");
const { parseQr, SyncClient, syncMessage } = require("../www/js/syncclient.js");

const REPO = path.resolve(__dirname, "..", "..");
const PYTHON = [
  path.join(REPO, ".venv", "Scripts", "python.exe"),
  path.join(REPO, ".venv", "bin", "python"),
].find((p) => fs.existsSync(p));
const ITER = 1000; // PBKDF2 réduit pour le test
const CODE = "123456";
const NEW_CODE = "654321";

function startPc() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-e2e-"));
  const py = spawn(PYTHON, ["-I", path.join(__dirname, "pc_server.py"), REPO, tmp], { stdio: ["pipe", "pipe", "inherit"] });
  const waiters = [];
  readline.createInterface({ input: py.stdout }).on("line", (l) => waiters.shift()(JSON.parse(l)));
  const send = (cmd) => new Promise((res, rej) => {
    waiters.push((r) => (r.ok ? res(r.r) : rej(new Error(`PC : ${r.error}`))));
    py.stdin.write(JSON.stringify(cmd) + "\n");
  });
  const pc = (name) => ({
    call: (method, ...args) => send({ pc: name, op: "call", name: method, args }),
    qr: () => send({ pc: name, op: "sync_start" }),
    devices: () => send({ pc: name, op: "devices" }),
  });
  const stop = () => {
    py.stdin.end();
    py.kill();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  };
  const setApk = (size) => send({ op: "set_apk", size });
  return { main: pc("main"), forger: pc("forger"), setApk, stop };
}

test("vrai PC ↔ téléphone : appairage, fusion, faux PC, code changé, restauration", {
  skip: PYTHON ? false : "environnement Python du dépôt absent (.venv) : crée-le pour lancer ce test",
  timeout: 30000,
}, async () => {
  const { main, forger, stop } = startPc();
  try {
    const store = nativeFake.memoryStore();
    let native = nativeFake.create({ store });
    let phone = new LocalApi({ native, iterations: ITER });

    // Une synchro complète comme views/sync.js : QR, hello (avec preuve), sync, apply_sync.
    async function sync(pc, codes = []) {
      const qr = parseQr(await pc.qr());
      const client = new SyncClient({ qr, post: (u, b, t) => native.post(u, b, t), crypto });
      try {
        const info = await phone.sync_info();
        const hello = await client.hello(info, { pair: await phone.sync_pair() });
        assert.equal(hello.ok, true, JSON.stringify(hello));
        const payload = await phone.sync_payload();
        const vault = hello.mode === "merge" ? payload : null;
        let reply;
        let used = null;
        for (const code of [null, ...codes]) {
          used = code;
          reply = await client.sync(syncMessage(info, hello, { vault, code, now: (await phone.sync_info()).now }));
          if (reply.ok || reply.error !== "code_required") break;
        }
        assert.equal(reply.ok, true, JSON.stringify(reply));
        assert.deepEqual(await phone.apply_sync({ ...reply, pc: hello.pc }, used), {});
        return { hello, reply };
      } finally {
        await pc.call("sync_stop");
      }
    }

    // PC : un compte, une carte, verrou PIN
    await main.call("start_empty", "Jules");
    const pid = (await main.call("get_state")).profiles[0].id;
    await main.call("save_account", { name: "Netflix", login: "jules", password: "pw-pc", profiles: [pid] });
    await main.call("save_giftcard", { name: "Fnac", code: "123", pin: "", initial: 50, remaining: 50, end_date: null, profiles: [pid] });
    await main.call("set_lock", "pin", CODE);

    // 1. première synchro : code exigé, secret d'appairage reçu et gardé chiffré
    let { hello, reply } = await sync(main, [CODE]);
    assert.equal(hello.need_code, true);
    assert.equal(hello.reason, "first");
    const pair1 = await phone.sync_pair();
    assert.equal(typeof pair1, "string");
    assert.equal(reply.pair, pair1);
    assert.deepEqual((await main.devices())[(await phone.sync_info()).device_id], ["last_sync", "name", "pair"]);

    // 2. redémarrage de l'appli, déverrouillage avec le code du PC
    native = nativeFake.create({ store });
    phone = new LocalApi({ native, iterations: ITER });
    assert.equal((await phone.get_state()).locked, true);
    assert.equal((await phone.unlock(CODE)).ok, true);

    // 3. modification et dépense sur le téléphone, fusion sans code (preuves échangées)
    const acc = (await phone.list_accounts(null))[0];
    await phone.save_account({ ...acc, password: "pw-phone" });
    const card = (await phone.list_giftcards(null))[0];
    await phone.spend(card.id, 12.5);
    ({ hello, reply } = await sync(main));
    assert.equal(hello.mode, "merge");
    assert.equal(hello.need_code, false);
    assert.equal(typeof hello.proof_pc, "string");
    assert.equal(reply.summary.to_pc, 2);
    assert.ok(!("pair" in reply));
    assert.equal((await main.call("list_accounts", null))[0].password, "pw-phone");
    assert.equal((await main.call("list_giftcards", null))[0].remaining, 37.5);

    // 4. faux PC (QR d'un autre PC) : refusé au hello, avant tout code ou coffre
    await forger.call("start_empty", "Pirate");
    await forger.call("set_lock", "pin", "000000");
    const fq = parseQr(await forger.qr());
    const fc = new SyncClient({ qr: fq, post: (u, b, t) => native.post(u, b, t), crypto });
    await assert.rejects(fc.hello(await phone.sync_info(), { pair: await phone.sync_pair() }), { code: "unpaired" });
    await assert.rejects(fc.sync(syncMessage(await phone.sync_info(), { mode: "replace" }, { code: CODE })), /hello d'abord/);
    await forger.call("sync_stop");
    assert.deepEqual(await forger.devices(), {});

    // 5. code du PC changé : preuve valide mais code redemandé, nouveau secret ; le téléphone s'ouvre avec
    await main.call("set_lock", "pin", NEW_CODE);
    ({ hello, reply } = await sync(main, [NEW_CODE]));
    assert.equal(hello.need_code, true);
    assert.equal(hello.mode, "merge");
    assert.equal(typeof hello.proof_pc, "string");
    const pair2 = await phone.sync_pair();
    assert.notEqual(pair2, pair1);
    await phone.lock();
    assert.equal((await phone.unlock(NEW_CODE)).ok, true);

    // 6. restauration sur le PC : le registre restauré a l'ancien secret → PC non reconnu ;
    // « Ré-appairer » → code du PC (celui de la sauvegarde) exigé, remplacement, nouveau secret
    const backups = await main.call("list_backups"); // la plus récente d'abord
    await main.call("restore_backup", backups[backups.length - 1].name);
    // sauvegarde chiffrée avec l'ancien code : le PC la rouvre avec celui-ci
    let restoredCode = NEW_CODE;
    if ((await main.call("get_state")).locked) {
      restoredCode = CODE;
      assert.equal((await main.call("unlock", CODE)).ok, true);
    }
    const rq = parseQr(await main.qr());
    const rc = new SyncClient({ qr: rq, post: (u, b, t) => native.post(u, b, t), crypto });
    await assert.rejects(rc.hello(await phone.sync_info(), { pair: await phone.sync_pair() }), { code: "unpaired" });
    await rc.cancel();
    await main.call("sync_stop");
    await phone.forget_pair();
    ({ hello, reply } = await sync(main, [restoredCode]));
    assert.equal(hello.need_code, true);
    assert.equal(hello.reason, "restored");
    const pair3 = await phone.sync_pair();
    assert.ok(pair3 && pair3 !== pair1 && pair3 !== pair2);
    ({ hello } = await sync(main));
    assert.equal(hello.need_code, false);
    assert.equal(hello.mode, "merge");
  } finally {
    stop();
  }
});

test("vrai PC : téléphone 0.9.0 → mise à jour exigée, APK reçu dans la session, empreinte conforme", {
  skip: PYTHON ? false : "environnement Python du dépôt absent (.venv) : crée-le pour lancer ce test",
  timeout: 60000,
}, async () => {
  const { main, setApk, stop } = startPc();
  try {
    const native = nativeFake.create({ store: nativeFake.memoryStore() });
    const phone = new LocalApi({ native, iterations: ITER });
    await main.call("start_empty", "Jules");
    await main.call("set_lock", "pin", CODE);
    const sha = await setApk(4 * 1024 * 1024 + 3);
    const version = fs.readFileSync(path.join(REPO, "VERSION"), "utf8").trim();

    const qr = parseQr(await main.qr());
    const client = new SyncClient({ qr, post: (u, b, t) => native.post(u, b, t), crypto });
    const info = { ...(await phone.sync_info()), app_version: "0.9.0" };
    const err = await client.hello(info, { pair: null }).catch((e) => e);
    assert.equal(err.code, "update_required", String(err && err.message));
    assert.deepEqual(err.details, {
      current: "0.9.0", available: version, size: 4 * 1024 * 1024 + 3, sha256: sha,
      message: `Une nouvelle version de l'appli est disponible (0.9.0 → ${version}) : mets-la à jour pour synchroniser.`,
    });
    const bytes = await client.downloadApk();
    assert.equal(bytes.length, 4 * 1024 * 1024 + 3);
    assert.equal(require("node:crypto").createHash("sha256").update(bytes).digest("hex"), sha);
    await native.installApk(bytes);
    assert.equal(native.installed.length, 1);
    const status = await main.call("sync_status");
    assert.match(String(status.notice), /^✓ Appli envoyée au téléphone de /);
    await client.cancel();
  } finally {
    await main.call("sync_stop").catch(() => {});
    stop();
  }
});
