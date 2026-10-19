// Tests du chiffrement du téléphone, compatible avec app/sync.py.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../www/js/crypto.js");

const v = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../../tests/fixtures/sync_vector.json"), "utf8"));
const key = C.unb64u(v.key);
const nonce = C.unb64u(v.nonce);

test("ouvre le vecteur Python", async () => {
  assert.deepEqual(await C.open(key, v.body, v.aad), v.plaintext);
});

test("seal avec le nonce du vecteur = corps Python", async () => {
  assert.equal(await C.seal(key, v.plaintext, v.aad, nonce), v.body);
});

test("b64u aller-retour sans remplissage", () => {
  const b = new Uint8Array([251, 255, 0, 1]);
  const s = C.b64u(b);
  assert.ok(!/[=+/]/.test(s));
  assert.deepEqual(C.unb64u(s), b);
});

test("mauvaise clé → bad_crypto", async () => {
  await assert.rejects(C.open(C.randomBytes(32), v.body, v.aad), /bad_crypto/);
});

test("mauvais AAD → bad_crypto", async () => {
  await assert.rejects(C.open(key, v.body, C.AAD_RESP), /bad_crypto/);
});

test("corps invalide → bad_crypto", async () => {
  await assert.rejects(C.open(key, "pas du json", v.aad), /bad_crypto/);
});

test("wrap/unwrap avec le code (1000 itérations en test)", async () => {
  const dk = C.randomBytes(32);
  const w = await C.wrapWithCode(dk, "123456", 1000);
  assert.equal(w.iter, 1000);
  assert.deepEqual(await C.unwrapWithCode(w, "123456"), dk);
});

test("mauvais code → bad_code", async () => {
  const w = await C.wrapWithCode(C.randomBytes(32), "123456", 1000);
  await assert.rejects(C.unwrapWithCode(w, "654321"), /bad_code/);
});

test("coffre : aller-retour puis altéré → corrupt", async () => {
  const dk = C.randomBytes(32);
  const obj = { a: 1, nom: "Café" };
  const blob = await C.encryptVault(dk, obj);
  assert.equal(blob.v, 1);
  assert.deepEqual(await C.decryptVault(dk, blob), obj);
  const ct = C.unb64u(blob.ct);
  ct[0] ^= 1;
  await assert.rejects(C.decryptVault(dk, { ...blob, ct: C.b64u(ct) }), /corrupt/);
});

test("itérations par défaut ≥ 600000", () => {
  assert.ok(C.PBKDF2_ITERATIONS >= 600000);
});
