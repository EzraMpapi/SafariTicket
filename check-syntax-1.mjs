/**
 * Parse and bundle the client before shipping it.
 *
 * A deploy once failed on a stray comment fragment that no amount of reading had
 * caught, because JSX cannot be validated by `node --check`. This runs the same
 * transformer Vite uses, so a syntax error surfaces in seconds locally instead
 * of after a push.
 *
 * Two passes, because they catch different things:
 *   1. transform every file — syntax
 *   2. bundle the graph    — missing files, bad relative paths, imports of
 *                            names a module does not actually export
 *
 * esbuild comes from Vite's own dependency tree, so there is nothing extra to
 * install.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/web/package.json"));

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  process.stderr.write("check-syntax: esbuild not found — run `npm install` first\n");
  process.exit(1);
}

const SKIP = new Set(["node_modules", "dist", ".git", "domain"]); // domain/ under _shared is vendored

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(jsx?|mjs|ts|tsx)$/.test(e.name)) yield p;
  }
}

let failures = 0, checked = 0;

for (const dir of ["apps", "packages", "services", "supabase/functions", "scripts"]) {
  for await (const file of walk(join(root, dir))) {
    checked++;
    const ext = file.split(".").pop();
    try {
      await esbuild.transform(await readFile(file, "utf8"), {
        loader: ext === "ts" ? "ts" : ext === "tsx" ? "tsx" : ext === "jsx" ? "jsx" : "js",
        jsx: "automatic", format: "esm", target: "es2022", sourcefile: file,
      });
    } catch (err) {
      failures++;
      if (Array.isArray(err.errors) && err.errors.length) {
        process.stderr.write(`\nSYNTAX  ${file.replace(root + "/", "")}\n`);
        for (const e of err.errors) {
          process.stderr.write(`  ${e.location?.line}:${e.location?.column}  ${e.text}\n`);
          if (e.location?.lineText) process.stderr.write(`    | ${e.location.lineText.trim()}\n`);
        }
      } else {
        // Not a parse failure — esbuild itself could not run.
        process.stderr.write(`\nTOOLING  esbuild failed on ${file.replace(root + "/", "")}\n`);
        process.stderr.write(`  ${err.message}\n`);
        process.stderr.write("  This is an environment problem, not a code problem.\n");
        process.stderr.write("  Try: rm -rf node_modules && npm install\n");
        process.exit(2);
      }
    }
  }
}

if (!failures) {
  try {
    const result = await esbuild.build({
      entryPoints: [join(root, "apps/web/src/main.jsx")],
      bundle: true, write: false, format: "esm", target: "es2022",
      jsx: "automatic", logLevel: "silent",
      external: ["react", "react-dom", "react/*", "react-dom/*", "lucide-react", "@supabase/supabase-js", "*.css"],
      alias: { "@safaritiketi/domain": join(root, "packages/domain/src/index.js") },
      define: {
        "import.meta.env.VITE_SUPABASE_URL": '"https://example.supabase.co"',
        "import.meta.env.VITE_SUPABASE_ANON_KEY": '"placeholder"',
      },
    });
    process.stdout.write(`check-syntax: ${checked} files parsed, graph bundles (${Math.round(result.outputFiles[0].contents.length / 1024)} KB)\n`);
  } catch (err) {
    failures++;
    process.stderr.write("\nBUNDLE\n");
    for (const e of err.errors ?? []) {
      process.stderr.write(`  ${e.location?.file}:${e.location?.line}  ${e.text}\n`);
    }
  }
}

if (failures) {
  process.stderr.write(`\n${failures} problem(s). Refusing to build.\n`);
  process.exit(1);
}
