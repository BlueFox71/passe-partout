// Chiffrement du téléphone : enveloppe de synchro (compatible app/sync.py),
// protection de la clé de données par le code, chiffrement du coffre local.
(function (root) {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const AAD_REQ = "pp-sync-v1:req";
  const AAD_RESP = "pp-sync-v1:resp";
  const AAD_VAULT = "pp-vault-v1";
  const AAD_WRAP = "pp-wrap-v1";
  const PBKDF2_ITERATIONS = 600000;
  // Appairage (Ruling 21, comme app/syncflow.py) : HMAC-SHA256(secret, clé du QR ‖ étiquette)
  const PROOF_PHONE = "pp-phone-hello";
  const PROOF_PC = "pp-pc-hello";

  // Base64url sans remplissage "=", comme côté PC.
  function b64u(bytes) {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function unb64u(str) {
    const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function randomBytes(n) {
    return globalThis.crypto.getRandomValues(new Uint8Array(n));
  }

  function importKey(raw) {
    return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }

  // AES-256-GCM : le tag est ajouté au chiffré, comme avec cryptography en Python.
  async function gcmEncrypt(key, nonce, aad, plain) {
    const k = await importKey(key);
    const ct = await subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) }, k, plain);
    return new Uint8Array(ct);
  }

  async function gcmDecrypt(key, nonce, aad, ct) {
    const k = await importKey(key);
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) }, k, ct);
    return new Uint8Array(plain);
  }

  // Corps {"n":…,"c":…} : ordre des clés et JSON compact identiques au PC.
  async function seal(key, obj, aad, nonce) {
    const n = nonce || randomBytes(12);
    const ct = await gcmEncrypt(key, n, aad, enc.encode(JSON.stringify(obj)));
    return JSON.stringify({ n: b64u(n), c: b64u(ct) });
  }

  async function open(key, body, aad) {
    try {
      const d = JSON.parse(body);
      const plain = await gcmDecrypt(key, unb64u(d.n), aad, unb64u(d.c));
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      throw new Error("bad_crypto");
    }
  }

  async function deriveFromCode(code, salt, iterations) {
    const base = await subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
    const bits = await subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256);
    return new Uint8Array(bits);
  }

  // Protège la clé de données avec une clé dérivée du code de déverrouillage.
  async function wrapWithCode(dataKey, code, iterations = PBKDF2_ITERATIONS) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const kek = await deriveFromCode(code, salt, iterations);
    const ct = await gcmEncrypt(kek, iv, AAD_WRAP, dataKey);
    return { salt: b64u(salt), iter: iterations, iv: b64u(iv), ct: b64u(ct) };
  }

  async function unwrapWithCode(wrapped, code) {
    try {
      const kek = await deriveFromCode(code, unb64u(wrapped.salt), wrapped.iter);
      return await gcmDecrypt(kek, unb64u(wrapped.iv), AAD_WRAP, unb64u(wrapped.ct));
    } catch (e) {
      throw new Error("bad_code");
    }
  }

  // Coffre local : JSON chiffré avec la clé de données.
  async function encryptVault(dataKey, obj) {
    const iv = randomBytes(12);
    const ct = await gcmEncrypt(dataKey, iv, AAD_VAULT, enc.encode(JSON.stringify(obj)));
    return { v: 1, iv: b64u(iv), ct: b64u(ct) };
  }

  async function decryptVault(dataKey, blob) {
    try {
      const plain = await gcmDecrypt(dataKey, unb64u(blob.iv), AAD_VAULT, unb64u(blob.ct));
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      throw new Error("corrupt");
    }
  }

  // Preuve d'appairage pour une session : base64url(HMAC-SHA256(pair, qrKey ‖ label)).
  async function pairProof(pair, qrKey, label) {
    const k = await subtle.importKey("raw", pair, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const tag = enc.encode(label);
    const data = new Uint8Array(qrKey.length + tag.length);
    data.set(qrKey, 0);
    data.set(tag, qrKey.length);
    return b64u(new Uint8Array(await subtle.sign("HMAC", k, data)));
  }

  // Comparaison de deux chaînes sans sortie anticipée.
  function sameText(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  const api = {
    b64u, unb64u, randomBytes, AAD_REQ, AAD_RESP, seal, open, PROOF_PHONE, PROOF_PC, pairProof, sameText,
    PBKDF2_ITERATIONS, wrapWithCode, unwrapWithCode, encryptVault, decryptVault,
  };
  root.PPM = root.PPM || {};
  root.PPM.crypto = api;
  if (typeof module === "object") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
