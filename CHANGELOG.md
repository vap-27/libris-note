# Libris Changelog

> Complete version history of the 3D Book Notes app. A new minor version for
> every change batch: `1.x` = foundation, `2.x` = identity + engine migration
> + honest telemetry, `3.x` = naming cleanup + polish + deploy hardening.

---

## 1.0 — 3D book core

### Added
- Saddle-brown leather volume with yellow-gold foil embossing, banded spine, gilded fore-edge, physical curvature shading.
- Dual-page spread on desktop (single-page responsive under 900px).
- Realistic page turns: drag corners with curl lift + tilt + cast shading, click outer margins, arrow keys, multi-page riffle without flashing.
- Smooth open animation driven by a unified `requestAnimationFrame` loop.
- Writable ruled pages — typography sits precisely ON the rules; titles in the header.
- Reading position bookmark (`lastPage`) persisted per book.
- Front cover: brand, kicker, CTAs ("Open the book", "Notes board"), live meta pill.
- `BookApp` orchestrator, `BookStage` 3D rig, `PageFace` editor component split.

---

## 1.1 — Page lifecycle

### Added
- Add fresh pages after the current reading position via toolbar, index drawer, trailing blank sheet, or `N` key.
- Rapid clicks mint exactly one page (creation guard).
- Any character keeps a page forever; empty pages auto-pruned by the sweeper.
- Deleting a page renumbers all subsequent sheets and shifts margin notes along.
- Page pinning: pinned pages are never auto-pruned.

### Fixed
- Stale-snapshot deletes: every DELETE re-validated live before firing.
- Display re-corrected after shrink so the spread never lands on a missing sheet.

---

## 1.2 — Felt board

### Added
- Infinite felt canvas with sticky notes and ruled note cards.
- Drag from anywhere on a note, free writing, per-note colors (stickies), fixed-cream cards.
- Soft-delete to trash with restore, per-note hard purge, empty-trash-all.
- Pinned notes lock canvas coordinates; resizable pinned notes.
- Draggable day-by-day timeline slider filtering notes oldest → newest.
- Book-plus action duplicates a board note into the book as a fresh numbered page.
- Atomic z-allocation (`MAX(z)+1 … FOR UPDATE` inside the insert transaction).

---

## 1.3 — Search, index, export, zoom

### Added
- Toolbar search across pages, headings, body text AND margin notes on both clusters, with preview snippets.
- Live index drawer (`I`): every page with word count, pin status, margin-note markers; click riffles to the page.
- One-click plaintext export compiling the manuscript to `libris.txt`.
- Reading zoom (`Z`, 1.45x) with click-drag panning; pages go read-only in zoom to prevent accidents.

---

## 1.4 — Dual TiDB + backup engine

### Added
- Cluster A (`books_db`): books + pages. Cluster B (`notes_db`): margin + board notes. Independent Prisma clients.
- Full snapshot backups TiDB → backup engine; LWW restore with stale-skip and tombstone guards.
- Dynamic storage shift: writes route to backup under 10 MB TiDB remaining; critical peak protection under 1 MB.
- Continuous dual-write replication with queued retry (cap 500, backoff, 10 attempts).
- Merged reads: backup-shifted rows merge into TiDB lists so they never look deleted.

---

## 1.5 — Observability

### Added
- `/health`: per-engine liveness + latency, shift status, capacity, manual diagnostics, refresh intervals, live activity stream, log clearing.
- `/storage`: disk bytes, table inventory, snapshot backup/restore controls, repair + prune actions.
- 100% genuine activity logging (`system_logs`) for creates, edits, deletes, restores, shifts, syncs — no mocks.
- Backup metadata (`last_backup_at`), replication stats, count-divergence counters.

---

## 1.6 — Security hardening

### Added
- CSRF middleware gating all non-GET `/api/*` (host-matched Origin/Referer; headerless clients pass).
- Tiered rate limits (read/write/destructive), enforced *before* auth on destructive routes (no 401 oracle); Upstash Redis or in-memory fallback.
- Allowlist HTML sanitizer mirrored on server and client: dangerous tags/attrs, `javascript:`, inline styles stripped.
- Restore requires explicit `{"confirm":"RESTORE"}`; idempotency keys on creates.
- `ADMIN_TOKEN` gate (unset = public open mode); no `NEXT_PUBLIC_*` secrets; strict CSP in production.

---

## 1.7 — Tombstones + sweeper backstop

### Added
- Soft-deleted pages park at unique negative page numbers (stable across delete→recreate→delete cycles), never renumbered.
- Server-side sweep guard refuses non-blank, pinned, titled, on-screen, or fresh (< 60 s) pages with 409.
- Tombstones propagate to the backup mirror; restores keep them dead unless forced.
- `prune` hard-deletes tombstones older than N days on both engines and expires 30-day logs.

---

## 1.8 — Editor + board polish

### Added
- `Ctrl+E` floating toolbar (portaled, viewport-clamped): bold, italic, headings, bullet/numbered lists.
- 9-color highlighter that replaces instead of nesting; eraser returns plain ink.
- Span unwrap/heal for legacy escaped markup; only `ink-hl*` palette classes survive.
- Board cards cream-only; card text seated on ruled lines; Trail `+` per-page add.

---

## 1.9 — Tests + docs

### Added
- DB-free vitest suite (63 tests): sanitizer parity, rate limiter, failover rules, CSRF, identity crypto.
- `README` (product tour, architecture diagram, API table, setup), `docs/technical-flow.md` (flows, invariants).
- Manual live-DB probe scripts (`verify-all`, `verify-schemas`, failover suite, seed/restore demos) — never CI.

---

## 2.0 — Identity + presence

### Added
- Typed display names with 4–8 digit PIN claim/verify (continuity across cleared browsers, not auth).
- `IdentityGate` onboarding: claim, verify, or continue with a typed direct name (no auto-guest).
- 10-second presence heartbeats carrying versions + lock ops; advisory page edit leases (25 s TTL, 90 s server sweep).
- Presence pill, per-page lock banners, read-only foreign-locked faces, live-users strip on `/health`.
- `identity.ts` (shared) / `identity-client.ts` (browser) / `identity-server.ts` (node crypto) split.

---

## 2.1 — CockroachDB replaces Turso backup

### Added
- Snapshots, restore source, shift overflow, replication mirror, activity logs moved to CockroachDB (`BACKUP_DATABASE_URL`, `prisma/schema-backup.prisma`).
- First live snapshot verified; divergence healed; idempotent restore proven (0 overwrites, tombstones kept dead).

### Removed
- Old Turso backup database decommissioned (verified 502/inactive); credentials deleted.
- `turso*` export names temporarily kept so 15+ call sites kept working untouched.

---

## 2.2 — Users move to TiDB, Turso fully out

### Added
- Identities/presence/leases migrate to a third TiDB cluster (`users_db`: `identities`, `presence`, `page_locks`), DDL applied by hand (Prisma + TiDB both refuse a DB literally named `sys`).
- `src/lib/users-db.ts` Prisma singleton; `usrinfo.ts` fully rewritten on Prisma with identical exports.

### Removed
- `@libsql/client` uninstalled; zero Turso references remain in source.

---

## 2.3 — Real-data telemetry

### Added
- Measured content bytes everywhere (`octet_length`/`LENGTH` sums + per-row allowance) — the old `rows × 1024` estimate deleted.
- `bytesMeasured` honesty flags: CockroachDB/users report measured; TiDB reports `length-sum-estimate` (Serverless exposes no billed-size probe).
- Every quota labeled with its source (`tidb-starter-5gib-row-default`, `cockroachdb-cloud-basic-10gib-default`) plus `*_QUOTA_BYTES` env overrides.
- Units corrected to GiB with 2 decimals (`20.00 GiB`); probe failure renders "unmeasured", never a fabricated number.

---

## 2.4 — Live/tombstone splits + divergence

### Added
- Every table count reports `live` vs `tombstoned` in `/api/storage` (e.g. 14 pages = 7 live + 7 tombstoned).
- Inventory table shows per-cell splits; divergence compares TiDB vs backup per table with deltas.
- Combined quota total labeled as TiDB ×3 + CockroachDB with the users side-quota tracked separately.

---

## 2.5 — Front-cover life

### Added
- Meta pill shows live page count plus margin + sticky note counts (board count fetched up front).
- Floating "Last opened" pill measured against the real book corner at runtime (re-pinned after the entrance glide + on resize), dark theme, sparkle icon, italic slant.
- Gold-eye watchers tag: left-docked, draggable anywhere with persisted spot, counts every watcher including self and unregistered guests.
- Last-opened stamp persisted per browser; full timestamp on hover.

### Fixed
- Hydration crash from `localStorage` reads during render (moved to client-side effects).

---

## 2.6 — Gate + link fixes

### Added
- Gate inputs restyled for the dark dialog (previous ink-on-paper class was invisible).
- Claim/Verify buttons validate (name ≥ 2 chars, PIN 4–8 digits) with inline errors and disabled states.

### Fixed
- Front-cover Health/Storage links now clickable (`pointer-events` opt-in inside the click-through overlay).
- Gate action buttons: icon + label centered as one unit.

---

## 2.7 — Deploy pipeline

### Added
- `vercel-build` + `postinstall` generate all 4 Prisma clients (fresh deploys no longer crash on a missing client); `db:push:backup` script.
- `USERS_DATABASE_URL` + `BACKUP_DATABASE_URL` set on Vercel Production/Preview via CLI.
- `/dashboard` route renders the observability dashboard directly (no redirect hop).

---

## 2.8 — Quota corrections

### Changed
- CockroachDB Basic free corrected to **10 GiB** (verified against official pricing + docs; was a stale 5).
- Turso-free references purged; org-shared credit / RU-burn nuances documented in card tooltips.
- Health dashboard quotas (combined total, per-cluster, backup capacity) all read from the API instead of hardcoded literals.

---

## 2.9 — Status + inventory honesty

### Added
- Status pills turn red on offline/unreachable, amber when unconfigured, with the real status text.
- TiDB cards marked `(est.)` with tooltips; inventory gains users-cluster rows (identities, presence, leases).
- Dead `TURSO_*` vars removed from `.env`; `backup:*` script aliases added.

---

## 3.0 — Backup-engine rename

### Changed
- `src/lib/turso.ts` → `src/lib/backup-engine.ts`; ~30 exports renamed (`snapshotToBackup`, `restoreFromBackup`, `createBackupPage`, …).
- Response keys renamed (`backup:`, `overflow.backup`, `shiftedToBackup`); dashboards, scripts, tests, docs updated to match.
- `scripts/turso-backup.ts` → `scripts/backup.ts`; `turso:*` npm scripts removed.

### Kept (intentionally)
- `'Turso LibSQL'` engine string for old audit-log rows (renaming would orphan history).
- "Decommissioned Turso" notes where they record real history.

---

## 3.1 — Silent builds + lean deps

### Added
- `prisma/patch-prisma-turbopack-ignore.mjs` re-applies `turbopackIgnore` markers after every generate — 8 → 0 file-tracing warnings (lives in `prisma/` because `.vercelignore` excludes `scripts/`).
- Patch is deliberately non-fatal (a template drift must never break `npm install`); Prisma pinned to 6.19.3.

### Removed
- Dead deps verified unimported: `dnd-kit` ×3, `mdxeditor`, `next-auth`, `next-intl`.

### Fixed
- Deploys failed twice shipping this: missing script on Vercel (`Cannot find module …/scripts/…`) — fixed by the move; then a strict exit code — fixed by non-fatal.

---

## 3.2 — `/dashboard` first page

### Changed
- `/dashboard` renders the observability dashboard directly as its own first page (200, no redirect through `/health`).
- `/health` continues to serve the same dashboard.
