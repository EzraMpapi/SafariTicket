/**
 * Structured logging.
 *
 * One JSON object per line, because a log a machine cannot parse is a log
 * nobody reads at 3am. Every entry carries the request id, so a single
 * customer complaint can be traced across the whole request.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values must never reach a log line, at any depth. */
const REDACT = new Set([
  "password", "secret", "token", "authorization", "documentnumber",
  "piikey", "signingkeys", "tag", "barcode", "cvc", "pin",
]);

function scrub(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : scrub(v, depth + 1);
  }
  return out;
}

export function createLogger({ level = "info", service = "api", stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    stream.write(JSON.stringify({
      at: new Date().toISOString(), level: lvl, service, msg, ...scrub(fields ?? {}),
    }) + "\n");
  };

  const make = (base) => ({
    debug: (m, f) => emit("debug", m, { ...base, ...f }),
    info: (m, f) => emit("info", m, { ...base, ...f }),
    warn: (m, f) => emit("warn", m, { ...base, ...f }),
    error: (m, f) => emit("error", m, { ...base, ...f }),
    /** Derive a logger bound to a request. */
    child: (fields) => make({ ...base, ...fields }),
  });

  return make({});
}
