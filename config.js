/**
 * Configuration, validated once at boot.
 *
 * A service that starts with bad configuration and discovers it on the first
 * request has turned a deploy-time error into a customer-facing one. Everything
 * required is checked here, before the listener opens, and failures name both
 * the variable and what a correct value looks like.
 */

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.code = "INVALID_CONFIG";
    this.problems = problems;
  }
}

const ENVIRONMENTS = new Set(["development", "test", "staging", "production"]);

function parseSigningKeys(raw, problems) {
  if (!raw) {
    problems.push("SIGNING_KEYS is required, e.g. K2:ACTIVE:<32+ char secret>,K1:VERIFY_ONLY:<secret>");
    return [];
  }
  const keys = [];
  for (const entry of raw.split(",")) {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) {
      problems.push(`SIGNING_KEYS entry "${entry.trim().slice(0, 16)}…" must be <id>:<state>:<secret>`);
      continue;
    }
    const [id, state, secret] = parts;
    if (!/^[A-Z0-9]{2}$/.test(id)) problems.push(`SIGNING_KEYS: key id "${id}" must be two characters, A-Z0-9`);
    if (!["ACTIVE", "VERIFY_ONLY", "REVOKED"].includes(state)) {
      problems.push(`SIGNING_KEYS: key ${id} has state "${state}"; expected ACTIVE, VERIFY_ONLY or REVOKED`);
    }
    if (!secret || secret.length < 32) problems.push(`SIGNING_KEYS: key ${id} secret must be at least 32 characters`);
    keys.push({ id, state, secret });
  }
  const active = keys.filter((k) => k.state === "ACTIVE");
  if (keys.length && active.length !== 1) {
    problems.push(`SIGNING_KEYS must contain exactly one ACTIVE key, found ${active.length}`);
  }
  return keys;
}

function integer(raw, name, { min, max, fallback }, problems) {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) { problems.push(`${name} must be an integer, got "${raw}"`); return fallback; }
  if (min !== undefined && n < min) { problems.push(`${name} must be at least ${min}`); return fallback; }
  if (max !== undefined && n > max) { problems.push(`${name} must be at most ${max}`); return fallback; }
  return n;
}

export function loadConfig(env = process.env) {
  const problems = [];

  const nodeEnv = env.NODE_ENV || "development";
  if (!ENVIRONMENTS.has(nodeEnv)) {
    problems.push(`NODE_ENV "${nodeEnv}" must be one of ${[...ENVIRONMENTS].join(", ")}`);
  }
  const isProduction = nodeEnv === "production";

  const signingKeys = parseSigningKeys(env.SIGNING_KEYS, problems);

  // A single shared secret is how a "temporary" staging credential ends up in
  // production. Refuse the well-known placeholder outright.
  if (isProduction) {
    for (const k of signingKeys) {
      if (/replace-with|demo|test|changeme|example/i.test(k.secret)) {
        problems.push(`SIGNING_KEYS: key ${k.id} still holds a placeholder secret; production refuses to start`);
      }
    }
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    problems.push("DATABASE_URL is required, e.g. postgres://user:pass@host:5432/safaritiketi");
  } else if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push(`DATABASE_URL must be a postgres:// URL, got "${databaseUrl.slice(0, 12)}…"`);
  }

  const piiKey = env.PII_ENCRYPTION_KEY;
  if (!piiKey) {
    problems.push("PII_ENCRYPTION_KEY is required (32 bytes, base64) — passenger document numbers are regulated data");
  } else {
    let decoded;
    try { decoded = Buffer.from(piiKey, "base64"); } catch { decoded = null; }
    if (!decoded || decoded.length !== 32) {
      problems.push("PII_ENCRYPTION_KEY must decode to exactly 32 bytes; generate with: openssl rand -base64 32");
    }
  }

  const gateProvisioningToken = env.GATE_PROVISIONING_TOKEN;
  if (!gateProvisioningToken || gateProvisioningToken.length < 32) {
    problems.push("GATE_PROVISIONING_TOKEN is required (32+ chars) — it guards the endpoint that hands out verification keys");
  }

  const config = {
    nodeEnv,
    isProduction,
    port: integer(env.PORT, "PORT", { min: 1, max: 65535, fallback: 8080 }, problems),
    databaseUrl,
    databasePoolSize: integer(env.DATABASE_POOL_SIZE, "DATABASE_POOL_SIZE", { min: 1, max: 100, fallback: 10 }, problems),
    signingKeys,
    piiKey,
    gateProvisioningToken,
    seatHoldTtlMs: integer(env.SEAT_HOLD_TTL_MS, "SEAT_HOLD_TTL_MS", { min: 60_000, max: 3_600_000, fallback: 600_000 }, problems),
    shutdownGraceMs: integer(env.SHUTDOWN_GRACE_MS, "SHUTDOWN_GRACE_MS", { min: 0, max: 120_000, fallback: 15_000 }, problems),
    logLevel: env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    trustProxy: env.TRUST_PROXY === "true",
  };

  if (problems.length) throw new ConfigError(problems);
  return Object.freeze(config);
}

/** Safe to log at boot. Secrets are replaced, never truncated into a hint. */
export function redactConfig(config) {
  return {
    ...config,
    databaseUrl: config.databaseUrl?.replace(/\/\/[^@]*@/, "//***:***@"),
    signingKeys: config.signingKeys.map(({ id, state }) => ({ id, state })),
    piiKey: "[redacted]",
    gateProvisioningToken: "[redacted]",
  };
}
