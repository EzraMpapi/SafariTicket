/**
 * Gate device provisioning.
 *
 * Hands a verification keyring to an enrolled boarding device so it can validate
 * tickets with no network. This is the one endpoint that returns secret
 * material, so it is bearer-authenticated and must never be called from a
 * browser.
 *
 *   supabase functions deploy gate-keyring
 */

import { preflight, json, problem } from "../_shared/cors.ts";
import { gateKeyring, describeKeys } from "../_shared/signing.ts";

const expected = Deno.env.get("GATE_PROVISIONING_TOKEN");

/** Constant-time compare: a timing oracle on this token is still a leak. */
function tokenMatches(supplied: string, secret: string): boolean {
  if (supplied.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

Deno.serve((req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return problem(405, "method-not-allowed", "Method not allowed", "Use POST.", req);

  if (!expected || expected.length < 32) {
    return problem(500, "internal", "Internal error", "Provisioning is not configured.", req);
  }

  const auth = req.headers.get("authorization") ?? "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supplied || !tokenMatches(supplied, expected)) {
    return problem(401, "unauthorized", "Unauthorized", "A valid gate provisioning token is required.", req);
  }

  return json({ keyring: gateKeyring(), keys: describeKeys(), issuedAt: new Date().toISOString() }, 200, req);
});
