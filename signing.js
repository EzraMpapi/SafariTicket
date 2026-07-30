/**
 * Ticket signing service.
 *
 * This module is the reason the repository was split. Through v5 the signing
 * keys were literals in a browser bundle, which meant anyone who opened the
 * network tab could mint a valid boarding pass. Here they are loaded from the
 * environment (backed by a KMS in production), used only on the server, and
 * never serialised into any response.
 *
 * Key rotation is supported by design:
 *   ACTIVE       used to sign new tickets, and accepted at the gate
 *   VERIFY_ONLY  no longer signs, but tickets already in circulation still board
 *   REVOKED      rejected outright; used when a key is believed compromised
 *
 * A ticket issued eighteen months ago must still scan, so keys leave ACTIVE long
 * before they leave the keyring.
 */

import { computeTag, verifyTag } from "@safaritiketi/domain";

const KEY_ID_PATTERN = /^[A-Z0-9]{2}$/;

export class SigningError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SigningError";
    this.code = code;
  }
}

/**
 * @param {Array<{id:string, secret:string, state:'ACTIVE'|'VERIFY_ONLY'|'REVOKED'}>} keys
 */
export function createSigningService(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new SigningError("no signing keys configured", "NO_KEYS");
  }

  for (const k of keys) {
    if (!KEY_ID_PATTERN.test(k.id)) {
      throw new SigningError(`key id ${k.id} must be two characters, A-Z0-9`, "BAD_KEY_ID");
    }
    if (!k.secret || k.secret.length < 32) {
      throw new SigningError(`key ${k.id} secret is too short`, "WEAK_KEY");
    }
  }

  const active = keys.filter((k) => k.state === "ACTIVE");
  if (active.length !== 1) {
    // Two active keys means two valid answers to "which key signed this",
    // which is how rotation bugs turn into outages.
    throw new SigningError(`expected exactly one ACTIVE key, found ${active.length}`, "AMBIGUOUS_ACTIVE_KEY");
  }

  const activeKey = active[0];
  const byId = new Map(keys.map((k) => [k.id, k]));

  return {
    activeKeyId: activeKey.id,

    /** Signs a payload. The only place the active secret is read. */
    sign(message) {
      return { keyId: activeKey.id, tag: computeTag(activeKey.secret, message) };
    },

    /** Server-side verification, e.g. when reprinting or auditing a ticket. */
    verify(message, keyId, tag) {
      const key = byId.get(keyId);
      if (!key) return { ok: false, reason: "UNKNOWN_KEY" };
      if (key.state === "REVOKED") return { ok: false, reason: "REVOKED_KEY" };
      return verifyTag({ [keyId]: key.secret }, keyId, message, tag);
    },

    /**
     * The keyring provisioned to a gate device.
     *
     * Deliberately includes VERIFY_ONLY keys — older tickets must still board —
     * and deliberately excludes REVOKED ones. The device receives secrets
     * because offline verification requires them; that is why devices are
     * attested, enrolled, and revocable.
     *
     * This is never returned to a passenger client.
     */
    gateKeyring() {
      const ring = {};
      for (const k of keys) {
        if (k.state === "REVOKED") continue;
        ring[k.id] = k.secret;
      }
      return ring;
    },

    /** Safe to log and to expose on an admin endpoint. Contains no secrets. */
    describe() {
      return keys.map(({ id, state }) => ({ id, state, active: id === activeKey.id }));
    },
  };
}

/**
 * Load keys from the environment.
 *
 * Format: SIGNING_KEYS="K2:ACTIVE:<secret>,K1:VERIFY_ONLY:<secret>"
 * In production the secrets are KMS references resolved at boot, not literals.
 */
export function loadSigningKeysFromEnv(env = process.env) {
  const raw = env.SIGNING_KEYS;
  if (!raw) throw new SigningError("SIGNING_KEYS is not set", "NO_KEYS");

  return raw.split(",").map((entry) => {
    const [id, state, secret] = entry.trim().split(":");
    if (!id || !state || !secret) {
      throw new SigningError(`malformed SIGNING_KEYS entry: ${entry.slice(0, 12)}…`, "BAD_KEY_FORMAT");
    }
    return { id, state, secret };
  });
}

/**
 * Guard against the exact mistake this refactor exists to fix. Call it in the
 * web app's build step: if key material ever reaches a client bundle, fail the
 * build rather than shipping it.
 */
export function assertNoKeyMaterial(bundleSource) {
  const markers = [/SIGNING_KEYS/, /VERIFY_ONLY/, /\bsign\s*\(\s*message\s*\)/];
  const hits = markers.filter((m) => m.test(bundleSource));
  if (hits.length > 0) {
    throw new SigningError(
      `client bundle contains signing artefacts: ${hits.map(String).join(", ")}`,
      "KEY_MATERIAL_IN_CLIENT"
    );
  }
  return true;
}
