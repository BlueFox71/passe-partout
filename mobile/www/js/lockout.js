// Délai croissant après des codes erronés (même logique que app/lockout.py).
// `until` est un horodatage en millisecondes de l'horloge injectée.
(function (root) {
  const MAX_DELAY = 300;

  class Lockout {
    constructor(clock = Date.now, state = {}) {
      this._clock = clock;
      this._fails = 0;
      this._until = 0;
      this._restore(state);
    }

    // État invalide : ignoré.
    _restore(s) {
      if (!s || typeof s !== "object") return;
      const fails = Number(s.fails ?? 0);
      const until = Number(s.until ?? 0);
      if (!Number.isFinite(fails) || !Number.isFinite(until)) return;
      this._fails = Math.max(0, Math.trunc(fails));
      this._until = until;
    }

    waitSeconds() {
      return Math.max(0, Math.ceil((this._until - this._clock()) / 1000));
    }

    fail() {
      this._fails += 1;
      const delay = Math.min(2 ** (this._fails - 1), MAX_DELAY);
      this._until = this._clock() + delay * 1000;
    }

    success() {
      this._fails = 0;
      this._until = 0;
    }

    toJSON() {
      return { fails: this._fails, until: this._until };
    }
  }

  root.PPM = root.PPM || {};
  root.PPM.Lockout = Lockout;
  if (typeof module === "object") module.exports = Lockout;
})(typeof window !== "undefined" ? window : globalThis);
