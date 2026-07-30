/**
 * Runs the same contract against PostgreSQL when one is reachable.
 *
 *   DATABASE_URL=postgres://... npm run test:api
 *
 * Skipped otherwise rather than faked, so a green suite without a database
 * never implies the adapter was exercised.
 */
import { test } from "node:test";
import { runStoreContract } from "./store-contract.js";

const url = process.env.DATABASE_URL;

if (!url) {
  test("[postgres] contract skipped — set DATABASE_URL to run it", { skip: true }, () => {});
} else {
  const { default: pg } = await import("pg");
  const { createPgStore } = await import("../src/db/pg-store.js");
  const pool = new pg.Pool({ connectionString: url });

  runStoreContract("postgres", async () => {
    await pool.query("TRUNCATE seat_occupancy CASCADE");
    return createPgStore(pool);
  });

  process.on("beforeExit", () => pool.end());
}
