/**
 * Ticket signing. Runs only inside an Edge Function.
 *
 * The secrets come from TICKET_SIGNING_KEYS, set with `supabase secrets set`.
 * They are never returned to a browser and never written to the database — the
 * signing_key table stores an identifier and a lifecycle state only.
 */

type KeyState = "ACTIVE" | "VERIFY_ONLY" | "REVOKED";
interface SigningKey { id: string; state: KeyState; secret: string }

const TAG_LENGTH = 16; // 64-bit truncation, the barcode-sized trade-off

function parseKeys(): SigningKey[] {
  const raw = Deno.env.get("TICKET_SIGNING_KEYS");
  if (!raw) throw new Error("TICKET_SIGNING_KEYS is not set");

  const keys = raw.split(",").map((entry) => {
    const [id, state, secret] = entry.trim().split(":");
    if (!id || !state || !secret) throw new Error("malformed TICKET_SIGNING_KEYS entry");
    if (!/^[A-Z0-9]{2}$/.test(id)) throw new Error(`key id ${id} must be two characters`);
    if (secret.length < 32) throw new Error(`key ${id} secret is too short`);
    return { id, state: state as KeyState, secret };
  });

  if (keys.filter((k) => k.state === "ACTIVE").length !== 1) {
    throw new Error("exactly one ACTIVE signing key is required");
  }
  return keys;
}

const keys = parseKeys();
const activeKey = keys.find((k) => k.state === "ACTIVE")!;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const activeKeyId = activeKey.id;

export async function signMessage(message: string): Promise<{ keyId: string; tag: string }> {
  return { keyId: activeKey.id, tag: (await hmacHex(activeKey.secret, message)).slice(0, TAG_LENGTH) };
}

/** Verification secrets for an enrolled gate device. Excludes REVOKED keys. */
export function gateKeyring(): Record<string, string> {
  const ring: Record<string, string> = {};
  for (const k of keys) if (k.state !== "REVOKED") ring[k.id] = k.secret;
  return ring;
}

export function describeKeys() {
  return keys.map(({ id, state }) => ({ id, state, active: id === activeKey.id }));
}
