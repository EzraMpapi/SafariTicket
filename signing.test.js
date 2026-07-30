import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigningService, loadSigningKeysFromEnv, assertNoKeyMaterial, SigningError } from "../src/lib/signing.js";
import { buildBarcodePayload, parseAndVerify, issueTicketNumber, searchServices, todayISO } from "@safaritiketi/domain";

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const keys = () => [
  { id: "K2", state: "ACTIVE", secret: SECRET_A },
  { id: "K1", state: "VERIFY_ONLY", secret: SECRET_B },
];

const booking = () => {
  const svc = searchServices({ from: "DAR", to: "ARK", date: todayISO() })[0];
  return {
    locator: "ACDEF2",
    passengers: [{ firstName: "Asha", lastName: "Mbwana" }],
    segments: [{ service: svc, seats: [5] }],
    tickets: [issueTicketNumber("401", 1)],
  };
};

test("exactly one key may be active", () => {
  assert.throws(() => createSigningService([
    { id: "K1", state: "ACTIVE", secret: SECRET_A },
    { id: "K2", state: "ACTIVE", secret: SECRET_B },
  ]), /exactly one ACTIVE key/);
});

test("a weak or malformed key is refused at construction", () => {
  assert.throws(() => createSigningService([{ id: "K1", state: "ACTIVE", secret: "short" }]), /too short/);
  assert.throws(() => createSigningService([{ id: "KEY1", state: "ACTIVE", secret: SECRET_A }]), /two characters/);
  assert.throws(() => createSigningService([]), /no signing keys/);
});

test("a signed ticket verifies against the gate keyring", () => {
  const svc = createSigningService(keys());
  const payload = buildBarcodePayload(booking(), (m) => svc.sign(m));
  assert.equal(parseAndVerify(payload, svc.gateKeyring()).ok, true);
});

test("tickets signed by a retired key still board after rotation", () => {
  const before = createSigningService([{ id: "K1", state: "ACTIVE", secret: SECRET_B }]);
  const oldTicket = buildBarcodePayload(booking(), (m) => before.sign(m));

  // K1 is demoted, K2 takes over.
  const after = createSigningService(keys());
  assert.equal(after.activeKeyId, "K2");
  assert.equal(parseAndVerify(oldTicket, after.gateKeyring()).ok, true, "rotation invalidated live tickets");
});

test("a revoked key is dropped from the gate keyring", () => {
  const before = createSigningService([{ id: "K1", state: "ACTIVE", secret: SECRET_B }]);
  const compromised = buildBarcodePayload(booking(), (m) => before.sign(m));

  const after = createSigningService([
    { id: "K2", state: "ACTIVE", secret: SECRET_A },
    { id: "K1", state: "REVOKED", secret: SECRET_B },
  ]);
  assert.equal(Object.keys(after.gateKeyring()).includes("K1"), false);
  assert.equal(parseAndVerify(compromised, after.gateKeyring()).reason, "UNKNOWN_KEY");
});

test("server-side verify reports a revoked key distinctly", () => {
  const svc = createSigningService([
    { id: "K2", state: "ACTIVE", secret: SECRET_A },
    { id: "K1", state: "REVOKED", secret: SECRET_B },
  ]);
  assert.equal(svc.verify("msg", "K1", "0".repeat(16)).reason, "REVOKED_KEY");
});

test("describe() exposes no secrets", () => {
  const described = JSON.stringify(createSigningService(keys()).describe());
  assert.equal(described.includes(SECRET_A), false);
  assert.equal(described.includes(SECRET_B), false);
  assert.match(described, /"id":"K2"/);
});

test("keys load from the environment", () => {
  const loaded = loadSigningKeysFromEnv({ SIGNING_KEYS: `K2:ACTIVE:${SECRET_A},K1:VERIFY_ONLY:${SECRET_B}` });
  assert.equal(loaded.length, 2);
  assert.equal(createSigningService(loaded).activeKeyId, "K2");
});

test("a missing or malformed environment config fails loudly", () => {
  assert.throws(() => loadSigningKeysFromEnv({}), /SIGNING_KEYS is not set/);
  assert.throws(() => loadSigningKeysFromEnv({ SIGNING_KEYS: "garbage" }), /malformed/);
});

test("the build guard catches key material in a client bundle", () => {
  assert.throws(
    () => assertNoKeyMaterial("const x = process.env.SIGNING_KEYS;"),
    /KEY_MATERIAL_IN_CLIENT|signing artefacts/
  );
  assert.equal(assertNoKeyMaterial("export function renderTicket(){}"), true);
});
