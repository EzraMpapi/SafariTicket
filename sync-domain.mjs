/**
 * Copies packages/domain/src into supabase/functions/_shared/domain.
 *
 * Supabase deploys only the contents of supabase/functions, so a relative import
 * reaching outside that directory would resolve locally and fail once deployed.
 * Vendoring at build time keeps one source of truth in packages/domain while
 * giving the Edge Functions something they can actually deploy.
 *
 * Run before every `supabase functions deploy`. Wired into npm run predeploy.
 */
import { readdir, mkdir, copyFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "packages/domain/src");
const dest = join(root, "supabase/functions/_shared/domain");

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

const files = (await readdir(src)).filter((f) => f.endsWith(".js"));
for (const f of files) await copyFile(join(src, f), join(dest, f));

process.stdout.write(`vendored ${files.length} domain modules into supabase/functions/_shared/domain\n`);
