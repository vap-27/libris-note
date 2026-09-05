/**
 * Re-apply `turbopackIgnore` markers to Prisma-generated clients.
 *
 * Why: `src/generated/*-client/{index.js,runtime/library.js}` are emitted by
 * `prisma generate` (see postinstall / db:generate) and contain two dynamic
 * `process.cwd()` filesystem probes that Turbopack cannot statically scope:
 *
 *   1. index.js — `config.dirname = path.join(process.cwd(), alternativePath)`
 *      (engine/schema fallback lookup; template lives in
 *      node_modules/@prisma/client/generator-build/index.js)
 *   2. runtime/library.js — minified dotenv `.env.vault` lookup
 *      `Fi.existsSync(r)` where `r` joins `process.cwd()` (plus the
 *      openssl/ldconfig/libssl engine probe nearby on the same line)
 *
 * Each probe makes Turbopack warn "Dynamic filesystem access causes tracing
 * of the whole project" and bloats every server route trace. The sanctioned
 * opt-out (printed in the warning itself) is a `turbopackIgnore`
 * comment on the highlighted call. Those probes are runtime fallbacks that
 * resolve identically with or without bundling, so ignoring them for tracing
 * is safe — the query-engine binaries and schema.prisma annotations at the
 * bottom of index.js keep working and stay traced via their static joins.
 *
  * `serverExternalPackages` cannot cover these files (that option only matches
  * `node_modules/<pkg>/` paths, while our clients live in `src/generated/`),
  * and `outputFileTracingExcludes` only post-filters .nft.json files — worse,
  * excluding the clients there would drop the query-engine binaries from
  * standalone traces and break production. Hence this patch.
  *
  * Lives in `prisma/` (not `scripts/`) because `.vercelignore` excludes
  * `scripts/` from deployments while `postinstall` must run this file.
 *
 * The markers are lost every time `prisma generate` rewrites the clients, so
 * this script is chained after every generate invocation in package.json
 * (postinstall, vercel-build, db:generate, db:push, db:push:backup) and is
 * idempotent (safe to run repeatedly).
 *
 * Deliberately NON-FATAL: if a future Prisma version changes the template so
 * the patterns no longer match, this prints a loud warning and exits 0.
 * Failing would break `postinstall` → `npm install` → the whole deploy, and
 * these markers only suppress build warnings (cosmetic), never correctness.
 *
 * This file is intentionally `.mjs` + dependency-free: tsconfig only includes
 * TS source globs (so `tsc --noEmit` ignores it) and eslint ignores scripts.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENTS = ["backup-client", "books-client", "notes-client", "users-client"];
const MARKER = "/*turbopackIgnore: true*/";

const PATCHES = [
  {
    file: (c) => `src/generated/${c}/index.js`,
    // Flagged call: config.dirname = path.join(process.cwd(), alternativePath)
    from: "config.dirname = path.join(process.cwd(), alternativePath)",
    to: `config.dirname = path.join(${MARKER} process.cwd(), alternativePath)`,
  },
  {
    file: (c) => `src/generated/${c}/runtime/library.js`,
    // Flagged call (minified dotenv .env.vault probe): Fi.existsSync(r)
    from: "Fi.existsSync(r)",
    to: `Fi.existsSync(${MARKER} r)`,
  },
];

let changed = 0;
for (const client of CLIENTS) {
  for (const { file, from, to } of PATCHES) {
    const rel = file(client);
    const abs = join(root, rel);
    const src = readFileSync(abs, "utf8");
    if (src.includes(to)) continue; // already patched (idempotent)
    const occurrences = src.split(from).length - 1;
    if (occurrences !== 1) {
      // Non-fatal by design (see header): a template drift must never fail installs.
      console.warn(
        `[patch-prisma] WARNING: expected exactly 1 occurrence of ${JSON.stringify(from)} in ${rel}, found ${occurrences} — leaving untouched (warnings may return; update the pattern)`
      );
      continue;
    }
    writeFileSync(abs, src.replace(from, to));
    changed += 1;
    console.log(`[patch-prisma] patched ${rel}`);
  }
}
console.log(`[patch-prisma] done (${changed} file(s) updated)`);
