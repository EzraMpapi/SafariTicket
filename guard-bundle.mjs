/**
 * Post-build guard.
 *
 * The defect this whole repository exists to prevent is key material reaching a
 * browser. This inspects the built bundle — not the source — because a build
 * step, an alias or an accidental import can put a secret in the output that
 * never appears in any source file.
 *
 * Run automatically by `npm run build` in apps/web.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../apps/web/dist");

const FORBIDDEN = [
  [/SUPABASE_SERVICE_ROLE_KEY/, "service_role key reference"],
  [/service_role/, "service_role literal"],
  [/TICKET_SIGNING_KEYS/, "signing key environment name"],
  [/GATE_PROVISIONING_TOKEN/, "gate provisioning token"],
  [/PII_ENCRYPTION_KEY/, "PII encryption key"],
  [/"role"\s*:\s*"service_role"/, "service_role JWT"],
];

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(js|mjs|css|html|map)$/.test(e.name)) yield p;
  }
}

let failures = 0, scanned = 0;
for await (const file of walk(dist)) {
  scanned++;
  const source = await readFile(file, "utf8");
  for (const [pattern, label] of FORBIDDEN) {
    if (pattern.test(source)) {
      process.stderr.write(`LEAK: ${label} found in ${file}\n`);
      failures++;
    }
  }
}

if (scanned === 0) {
  process.stderr.write("guard: no build output found — run vite build first\n");
  process.exit(1);
}
if (failures) {
  process.stderr.write(`\nRefusing to ship: ${failures} leak(s) in the client bundle.\n`);
  process.exit(1);
}
process.stdout.write(`guard: ${scanned} bundle files scanned, no key material found\n`);
