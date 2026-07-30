/**
 * Synchronous SHA-256 and HMAC-SHA256.
 *
 * Web Crypto is async and cannot be called from inside a pure validator, and
 * the boarding gate must verify a ticket with no network and no `await`.
 *
 * This module deliberately holds NO key material. Keys are passed in by the
 * caller, so the same code runs in the signing service (which has the key) and
 * on the gate device (which has only the verification key). The browser bundle
 * imports the verifier and never receives a key at all.
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

export function sha256(bytes) {
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length;
  const padded = new Uint8Array((((len + 9) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  dv.setUint32(padded.length - 4, (len * 8) >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    const add = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) H[i] = (H[i] + add[i]) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

export function hmacSha256(keyBytes, msgBytes) {
  const BLOCK = 64;
  const key = keyBytes.length > BLOCK ? sha256(keyBytes) : keyBytes;
  const pad = new Uint8Array(BLOCK);
  pad.set(key);
  const inner = new Uint8Array(BLOCK + msgBytes.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) { inner[i] = pad[i] ^ 0x36; outer[i] = pad[i] ^ 0x5c; }
  inner.set(msgBytes, BLOCK);
  outer.set(sha256(inner), BLOCK);
  return sha256(outer);
}

export const utf8 = (s) => new TextEncoder().encode(s);
export const toHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** A timing oracle on a boarding tag is still a leak. */
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 64-bit truncation — the standard trade-off for a barcode-sized tag. */
export const TAG_LENGTH = 16;

export function computeTag(secret, message) {
  return toHex(hmacSha256(utf8(secret), utf8(message))).slice(0, TAG_LENGTH);
}

/**
 * @param keyring {Record<string,string>} id -> secret. The gate device holds a
 *   verification keyring; the browser holds none.
 */
export function verifyTag(keyring, keyId, message, tag) {
  const secret = keyring[keyId];
  if (!secret) return { ok: false, reason: "UNKNOWN_KEY" };
  if (!timingSafeEqual(computeTag(secret, message), tag)) return { ok: false, reason: "BAD_SIGNATURE" };
  return { ok: true };
}
