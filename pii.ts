/**
 * Column encryption for passenger document numbers, WebCrypto edition.
 *
 * Wire-compatible with services/api/src/lib/pii.js so a record written by
 * either can be read by the other:
 *   [ version:1 ][ iv:12 ][ authTag:16 ][ ciphertext:n ]
 *
 * WebCrypto appends the tag to the ciphertext, so it is split back out here to
 * preserve that layout rather than inventing a second one.
 */

const VERSION = 1, IV_BYTES = 12, TAG_BYTES = 16;

function keyBytes(): Uint8Array {
  const b64 = Deno.env.get("PII_ENCRYPTION_KEY");
  if (!b64) throw new Error("PII_ENCRYPTION_KEY is not set");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("PII_ENCRYPTION_KEY must decode to 32 bytes");
  return bytes;
}

const raw = keyBytes();

const aesKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
const indexKey = await crypto.subtle.importKey(
  "raw", new Uint8Array(await crypto.subtle.digest("SHA-256",
    new Uint8Array([...raw, ...new TextEncoder().encode("blind-index-v1")]))),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
);

export async function encryptDocument(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("empty document number");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 }, aesKey,
    new TextEncoder().encode(plaintext),
  ));

  const ct = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const out = new Uint8Array(1 + IV_BYTES + TAG_BYTES + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(tag, 1 + IV_BYTES);
  out.set(ct, 1 + IV_BYTES + TAG_BYTES);
  return btoa(String.fromCharCode(...out));
}

/** Deterministic, so equality lookups work without decryption. */
export async function blindIndex(plaintext: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", indexKey,
    new TextEncoder().encode(String(plaintext).trim().toUpperCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
