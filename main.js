/**
 * Service entrypoint.
 *
 * Order matters: validate configuration, then build dependencies, then open the
 * listener. Nothing accepts traffic until everything it needs is proven present.
 */

import process from "node:process";
import { loadConfig, redactConfig, ConfigError } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { createSigningService } from "./lib/signing.js";
import { createPiiCipher } from "./lib/pii.js";
import { createMemoryStore } from "./lib/memory-store.js";
import { createMemoryBookingStore } from "./lib/booking-store.js";
import { createApp } from "./http/app.js";
import { createServer } from "./http/server.js";

let config;
try {
  config = loadConfig();
} catch (err) {
  // Configuration failures print plainly and exit non-zero. A structured log
  // nobody has configured a sink for yet is not the place for this message.
  if (err instanceof ConfigError) {
    process.stderr.write(`\n${err.message}\n\nRefusing to start.\n\n`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel });

async function buildStores() {
  if (config.databaseUrl?.startsWith("postgres")) {
    try {
      const { default: pg } = await import("pg");
      const { createPgStore } = await import("./db/pg-store.js");
      const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.databasePoolSize });
      await pool.query("SELECT 1");
      logger.info("connected to postgres", { poolSize: config.databasePoolSize });
      return { seatStore: createPgStore(pool), bookingStore: createMemoryBookingStore(), pool };
    } catch (err) {
      // In production an unreachable database is fatal: serving from memory
      // would silently accept bookings nobody can ever retrieve.
      if (config.isProduction) {
        logger.error("database unavailable", { error: err.message });
        process.exit(75); // EX_TEMPFAIL — let the orchestrator retry
      }
      logger.warn("database unavailable; using in-memory stores", { error: err.message });
    }
  }
  return { seatStore: createMemoryStore(), bookingStore: createMemoryBookingStore(), pool: null };
}

const { seatStore, bookingStore, pool } = await buildStores();

const app = createApp({
  seatStore,
  bookingStore,
  signing: createSigningService(config.signingKeys),
  pii: createPiiCipher(config.piiKey),
  config,
  logger,
});

const { server, shutdown } = createServer(app, { logger, maxBodyBytes: app.MAX_BODY_BYTES });

server.listen(config.port, () => {
  logger.info("listening", { port: config.port, env: config.nodeEnv, config: redactConfig(config) });
});

/* ── lifecycle ─────────────────────────────────────────────────────────────
   A rolling deploy sends SIGTERM. Draining in-flight requests before exiting is
   the difference between a clean release and a handful of failed purchases.
   ──────────────────────────────────────────────────────────────────────── */

let shuttingDown = false;
async function stop(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("signal received", { signal });
  await shutdown(config.shutdownGraceMs);
  await pool?.end().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection", { error: String(reason?.message ?? reason) });
});
process.on("uncaughtException", (err) => {
  // An unknown-state process must not keep serving payments.
  logger.error("uncaught exception; exiting", { error: err.message, stack: err.stack });
  process.exit(1);
});
