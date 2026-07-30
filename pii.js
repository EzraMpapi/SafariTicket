/**
 * Column encryption for regulated passenger data.
 *
 * Document numbers (NIDA, passport) are personal data under Tanzania's Personal
 * Data Protection Act and every equivalent regime. They are encrypted before
 * they reach the database, so a dump, a backup, or a read-replica leak yields
 * ciphertext.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently returning wrong data.
 *
 * Storage layout (single bytea column):
 *   [ version:1 ][ iv:12 ][ authTag:16 ][ ciphertext:n ]
 *
 * The version byte exists so a future key rotation can re-encrypt lazily
 * instead of requiring one enormous migration.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DecryptionError";
    this.code = "DECRYPTION_FAILED";
  }
}

export function createPiiCipher(base64Key) {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("PII key must decode to exactly 32 bytes");

  // Derived, not reused: the blind-index key must never be the encryption key.
  const indexKey = createHmac("sha256", key).update("blind-index-v1").digest();

  return {
    /** @returns {Buffer} opaque bytes for a `bytea` column */
    encrypt(plaintext) {
      if (typeof plaintext !== "string" || plaintext.length === 0) {
        throw new TypeError("encrypt expects a non-empty string");
      }
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(buffer) {
      const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new DecryptionError("ciphertext is truncated");

      const version = buf[0];
      if (version !== VERSION) throw new DecryptionError(`unsupported ciphertext version ${version}`);

      const iv = buf.subarray(1, 1 + IV_BYTES);
      const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);

      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Deliberately uninformative: distinguishing "wrong key" from "tampered"
        // is useful to an attacker and to nobody else.
        throw new DecryptionError("could not decrypt");
      }
    },

    /**
     * Deterministic index for equality lookups ("find the booking with this ID
     * number") without decrypting the column or storing plaintext.
     *
     * Deterministic by necessity, which leaks equality — two identical document
     * numbers produce the same index. That is the cost of being able to search
     * at all, and it is the only property leaked.
     */
    blindIndex(plaintext) {
      return createHmac("sha256", indexKey).update(String(plaintext).trim().toUpperCase()).digest("hex");
    },

    blindIndexMatches(plaintext, storedIndex) {
      const computed = Buffer.from(this.blindIndex(plaintext), "hex");
      const stored = Buffer.from(String(storedIndex), "hex");
      return computed.length === stored.length && timingSafeEqual(computed, stored);
    },
  };
}

/** Masked form for manifests and support screens. Never the full number. */
export function maskDocumentNumber(plaintext) {
  const s = String(plaintext);
  if (s.length <= 4) return "•".repeat(s.length);
  return "•".repeat(s.length - 4) + s.slice(-4);
}
