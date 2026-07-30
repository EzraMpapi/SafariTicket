/**
 * Migration runner.
 *
 * Applies numbered SQL files exactly once, inside a transaction, guarded by an
 * advisory lock so two instances starting simultaneously cannot both migrate.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");
const LOCK_ID = 4_827_301; // arbitrary but fixed

export async function migrate(pool, { logger = console } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query("SELECT name FROM schema_migration");
    const applied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      logger.info?.(`applying ${file}`) ?? console.log(`applying ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err.message}`);
      }
    }
    return { applied: count, total: files.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => {});
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) { process.stderr.write("DATABASE_URL is required\n"); process.exit(78); }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url });
  try {
    const result = await migrate(pool);
    process.stdout.write(`migrations applied: ${result.applied} of ${result.total}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
