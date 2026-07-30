import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, redactConfig, ConfigError } from "../src/lib/config.js";

const VALID = {
  NODE_ENV: "production",
  SIGNING_KEYS: `K2:ACTIVE:${"a".repeat(40)},K1:VERIFY_ONLY:${"b".repeat(40)}`,
  DATABASE_URL: "postgres://user:pw@db:5432/safaritiketi",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  GATE_PROVISIONING_TOKEN: "g".repeat(40),
};

test("a complete environment loads", () => {
  const c = loadConfig(VALID);
  assert.equal(c.isProduction, true);
  assert.equal(c.port, 8080);
  assert.equal(c.seatHoldTtlMs, 600000);
  assert.equal(c.signingKeys.length, 2);
});

test("every missing variable is reported at once, not one per restart", () => {
  try {
    loadConfig({ NODE_ENV: "production" });
    assert.fail("expected ConfigError");
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.problems.length >= 4, `expected several problems, got ${err.problems.length}`);
    assert.match(err.message, /SIGNING_KEYS/);
    assert.match(err.message, /DATABASE_URL/);
    assert.match(err.message, /PII_ENCRYPTION_KEY/);
    assert.match(err.message, /GATE_PROVISIONING_TOKEN/);
  }
});

test("production refuses a placeholder secret", () => {
  assert.throws(
    () => loadConfig({ ...VALID, SIGNING_KEYS: `K2:ACTIVE:replace-with-a-real-secret-value-here-ok` }),
    /placeholder secret/
  );
});

test("development tolerates a placeholder so the sample env still boots", () => {
  const c = loadConfig({ ...VALID, NODE_ENV: "development", SIGNING_KEYS: `K2:ACTIVE:replace-with-a-real-secret-value-here-ok` });
  assert.equal(c.isProduction, false);
});

test("exactly one signing key may be active", () => {
  assert.throws(
    () => loadConfig({ ...VALID, SIGNING_KEYS: `K2:ACTIVE:${"a".repeat(40)},K1:ACTIVE:${"b".repeat(40)}` }),
    /exactly one ACTIVE key/
  );
});

test("a short signing secret is refused", () => {
  assert.throws(() => loadConfig({ ...VALID, SIGNING_KEYS: "K2:ACTIVE:tooshort" }), /at least 32 characters/);
});

test("a PII key of the wrong length is refused", () => {
  assert.throws(
    () => loadConfig({ ...VALID, PII_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") }),
    /exactly 32 bytes/
  );
});

test("a non-postgres database URL is refused", () => {
  assert.throws(() => loadConfig({ ...VALID, DATABASE_URL: "mysql://host/db" }), /must be a postgres/);
});

test("numeric bounds are enforced with a named variable", () => {
  assert.throws(() => loadConfig({ ...VALID, PORT: "70000" }), /PORT must be at most 65535/);
  assert.throws(() => loadConfig({ ...VALID, SEAT_HOLD_TTL_MS: "1000" }), /SEAT_HOLD_TTL_MS must be at least 60000/);
  assert.throws(() => loadConfig({ ...VALID, PORT: "eighty" }), /PORT must be an integer/);
});

test("config is frozen once loaded", () => {
  const c = loadConfig(VALID);
  assert.throws(() => { c.port = 9999; }, TypeError);
});

test("redaction removes every secret", () => {
  const printed = JSON.stringify(redactConfig(loadConfig(VALID)));
  assert.equal(printed.includes("a".repeat(40)), false, "signing secret leaked");
  assert.equal(printed.includes("g".repeat(40)), false, "gate token leaked");
  assert.equal(printed.includes(VALID.PII_ENCRYPTION_KEY), false, "pii key leaked");
  assert.equal(printed.includes(":pw@"), false, "database password leaked");
  assert.match(printed, /"id":"K2"/);
});
