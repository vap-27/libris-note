# Libris Changelog

> Versioned history of the 3D Book Notes app. `1.x` = foundation,
> `2.x` = identity + engine migration + honest telemetry,
> `3.x` = naming cleanup + polish + deploy hardening.

---

## 1.0 — 3D book core
- Saddle-brown leather volume, dual-page spread (single under 900px), drag/corner page turns.
- Writable ruled pages, titles in header, reading position bookmark.
- `BookApp` orchestrator + `BookStage` 3D rig + `PageFace` editor.

## 1.1 — Page lifecycle
- Add pages after cursor (`N`, toolbar, index, trailing sheet); rapid clicks mint one page.
- Delete renumbers subsequent sheets and shifts margin notes.
- Auto-sweeper prunes empty, unpinned, off-screen pages past fresh grace.

## 1.2 — Felt board
- Sticky notes + ruled cards on infinite canvas: drag, resize, recolor, pin.
- Trash with restore, per-note purge, empty-all; day-by-day timeline slider.
- Book-plus action duplicates a board note into the book as a fresh page.

## 1.3 — Search, index, export
- Cross-cluster search (pages + margin notes) with snippets.
- Live index drawer with word counts, pins, note markers.
- One-click plaintext export (`libris.txt`); reading zoom (`Z`).

## 1.4 — Dual TiDB + backup engine
- Cluster A (`books_db`): books + pages. Cluster B (`notes_db`): margin + board notes.
- Snapshot/restore replication mirror with last-write-wins and tombstone guards.
- Dynamic shift: writes route to backup under 10 MB TiDB remaining, critical at 1 MB.

## 1.5 — Observability
- `/health`: liveness, latencies, shift state, activity log stream, manual diagnostics.
- `/storage`: quotas, table inventory, snapshot/restore controls, repair/prune.
- 100% genuine activity logs persisted in `system_logs` — no mocks.

## 1.6 — Security hardening
- CSRF middleware on non-GET `/api/*`; rate limits (limit-before-auth on destructives).
- Allowlist HTML sanitizer mirrored server + client; restore requires `{"confirm":"RESTORE"}`.
- `ADMIN_TOKEN` gate; open public mode when unset. No `NEXT_PUBLIC_*` secrets.

## 1.7 — Tombstones + sweeper backstop
- Soft-deleted pages park at negative numbers; server refuses sweep of non-blank/pinned/titled pages.
- `prune` hard-deletes old tombstones on both engines + expires 30-day logs.

## 1.8 — Editor + board polish
- `Ctrl+E` floating toolbar (portal), 9-color highlighter without nesting, eraser, bullets.
- Cream-only cards, resizable pinned notes, text seated on ruled lines, clamped toolbar.

## 1.9 — Tests + docs
- DB-free vitest suite (sanitizer, limiter, failover rules, CSRF, identity) — 63 tests.
- `README`, `docs/technical-flow.md`, manual live-DB probe scripts.

---

## 2.0 — Identity + presence
- Typed display names with 4–8 digit PIN claim/verify (continuity, not auth).
- 10 s presence heartbeats, advisory page edit leases (25 s TTL), presence pill, lock banners.
- `IdentityGate` onboarding; `identity` / `identity-client` / `identity-server` split.

## 2.1 — CockroachDB replaces Turso backup
- Snapshots, restore, shift overflow, replication, logs move to CockroachDB (`BACKUP_DATABASE_URL`).
- Old Turso backup DB verified dead (502), credentials removed. `turso*` names kept temporarily for compat.

## 2.2 — Users move to TiDB, Turso fully out
- Identities/presence/leases migrate to third TiDB cluster (`users_db`, hand-applied DDL).
- `@libsql/client` uninstalled; zero Turso references in source.

## 2.3 — Real-data telemetry
- Measured content bytes (`octet_length`/`LENGTH` sums), `bytesMeasured` honesty flags.
- Quotas labeled with source + `*_QUOTA_BYTES` overrides; units corrected to GiB (2 decimals).
- Combined quota excludes the users side-quota (labeled).

## 2.4 — Live/tombstone splits
- Every table count reports live vs tombstoned; inventory shows "7 live · 7 tombstoned".
- Divergence counters compare TiDB vs backup per table.

## 2.5 — Front-cover life
- Pill shows live page + note counts (margin + stickies).
- Floating "Last opened" pill pinned to the book's bottom-right corner with italic slant.
- Draggable gold-eye watchers tag (counts self + guests, persisted spot).

## 2.6 — Gate + link fixes
- Visible gate input styling; no auto-guest — typed direct names.
- Front-cover Health/Storage links fixed (`pointer-events` opt-in inside click-through overlay).

## 2.7 — Deploy pipeline
- `vercel-build` generates all 4 Prisma clients (fresh deploys no longer crash on missing client).
- `USERS_DATABASE_URL` + `BACKUP_DATABASE_URL` set on Vercel Production/Preview; `/dashboard` route added.

## 2.8 — Quota corrections
- CockroachDB Basic free corrected to 10 GiB (verified vs official pricing; was stale 5).
- Turso-free references purged; org-shared/RU nuances documented in tooltips.

## 2.9 — Env + script hygiene
- Dead `TURSO_*` vars removed from `.env`; `backup:*` script aliases; `db:push:backup`.
- GiB tooltips, offline-red status pills, live/tombstone inventory rows.

---

## 3.0 — Backup-engine rename
- `turso.ts` → `backup-engine.ts`; all `turso*` exports, response keys (`backup:`, `overflow.backup`), scripts, tests, docs renamed end to end.
- Kept only: `'Turso LibSQL'` engine string for old audit rows + decommission history notes.

## 3.1 — Silent builds
- `turbopackIgnore` patch for Prisma-generated clients kills all 8 nft tracing warnings (re-applied post-generate via `prisma/` script — `scripts/` is Vercel-ignored).
- Dropped dead deps (`dnd-kit`, `mdxeditor`, `next-auth`, `next-intl`); pinned Prisma 6.19.3.

## 3.2 — `/dashboard` first page
- `/dashboard` renders the observability dashboard directly (no redirect hop).
