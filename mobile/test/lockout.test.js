// Tests du délai anti-essais (même sémantique que app/lockout.py).
const test = require("node:test");
const assert = require("node:assert");
const Lockout = require("../www/js/lockout.js");

test("délais 1, 2, 4 s… plafonnés à 300 s", () => {
  let now = 1000000;
  const l = new Lockout(() => now);
  assert.equal(l.waitSeconds(), 0);
  const attendus = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300];
  for (const s of attendus) {
    l.fail();
    assert.equal(l.waitSeconds(), s);
    now += s * 1000;
    assert.equal(l.waitSeconds(), 0);
  }
});

test("le succès remet à zéro", () => {
  const l = new Lockout(() => 0);
  l.fail(); l.fail();
  l.success();
  assert.equal(l.waitSeconds(), 0);
  l.fail();
  assert.equal(l.waitSeconds(), 1);
});

test("état restauré par le constructeur", () => {
  const l = new Lockout(() => 5000, { fails: 3, until: 9000 });
  assert.equal(l.waitSeconds(), 4);
  assert.deepEqual(l.toJSON(), { fails: 3, until: 9000 });
});

test("état invalide ignoré", () => {
  for (const s of [null, "x", { fails: "a" }, { fails: 1, until: "z" }]) {
    const l = new Lockout(() => 0, s);
    assert.deepEqual(l.toJSON(), { fails: 0, until: 0 });
  }
});
