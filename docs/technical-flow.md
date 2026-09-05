# Libris — Technical Flow & Architecture

> Single-source-of-truth companion to `README.md` (product tour) and
> `.env.example` (configuration). Covers request flows, data ownership,
> failure handling, and the invariants every change must preserve.

## 1. System overview

```
Browser (React 19)
 ├─ BookApp.tsx ........... orchestrator: book state, toolbar, panels, board host
 ├─ book/BookStage.tsx .... 3D stage: spread (≥640px) / single-page mode, flips, zoom
 ├─ book/PageFace.tsx ..... one writable ruled page (autosave, toolbar portal, pin/remove/+)
 ├─ book/{SearchBar,NotesPanel,IndexPanel,FloatingEditorToolbar}.tsx
 └─ board/BoardView.tsx ... sticky/card felt board, trash, timeline, zoom
        │  fetch /api/* (same origin, JSON)
        ▼
Next.js 16 App Router (src/app/api/**) + middleware.ts (CSRF gate)
 ├─ Prisma → TiDB Cluster A (books_db: Book, Page)
 ├─ Prisma → TiDB Cluster B (notes_db: PageNote, BoardNote)
 ├─ Prisma → TiDB Cluster C (users_db: Identity, Presence, PageLock)
 ├─ Prisma → CockroachDB (backup engine: snapshots, overflow, system_logs)
```

**Design stance (deliberate, do not "fix"):** the app is publicly writable —
no login. `ADMIN_TOKEN`, when set, gates every `/api` route; unset means
open mode. See `src/lib/auth.ts`.

## 2. Data model

### TiDB Cluster A — `prisma/schema.prisma` (`books_db`)
- `Book`: id, title, subtitle, author, description, coverTheme, `lastPage`
  (shared reading bookmark), timestamps.
- `Page`: id, bookId, pageNumber, chapter, section, title, content (HTML),
  pinned, **`deletedAt` (tombstone, Wave C)**, timestamps.
  - `@@unique([bookId, pageNumber])`, `@@index([bookId, section])`,
    `@@index([bookId, deletedAt, pageNumber])`.
  - Live rows: `deletedAt IS NULL AND pageNumber > 0` (0 = flyleaf).
  - Tombstones park at **negative** pageNumbers (unique across
    delete→recreate→delete cycles), never renumber.

### TiDB Cluster B — `prisma/schema-notes.prisma` (`notes_db`)
- `PageNote`: id, bookId, pageId, pageNumber (**denormalized copy**, kept in
  step by renumber sync), content, color, `deletedAt` (trash), timestamps.
- `BoardNote`: id, content, color, type (`sticky`|`card`), x, y, width,
  height, rotation, z, pinned, `deletedAt` (trash), timestamps.

### CockroachDB backup engine — `src/lib/turso.ts` front + `src/lib/db-backup.ts`
`books`, `pages` (+`deletedAt`), `page_notes`, `board_notes`,
`system_logs` (audit), `backup_meta(last_backup_at)`. The backup engine
mirrors TiDB including tombstones; it is the **only** place hard-deleted
TiDB rows can still exist (until `prune`). Export names (`turso*`,
`isTursoConfigured`, …) are historical — every byte goes to CockroachDB.

### Users store — `src/lib/usrinfo.ts` + `prisma/schema-users.prisma` (`users_db`)
`identities` (name + PIN hash), `presence` (heartbeats), `page_locks`
(advisory edit leases). Reached only via `/api/identity` + `/api/presence`.
DDL is applied by hand: Prisma refuses to manage a database literally named
`sys` and TiDB forbids DDL inside it, so the cluster got a dedicated
`users_db`; the Prisma client is generated from the schema for queries.

## 3. Read flows

- `GET /api/book[?limit&cursor]` → TiDB book + live pages → **merged** with
  backup-shifted rows (`getMergedBookPages`: dedupe by id, then newest
  `updatedAt` wins per `pageNumber`, warn on collision). `nextCursor` for
  paging; absent params = legacy full list.
- `GET /api/board[?trash][?limit&offset]`, `GET /api/notes?bookId[&trash]`,
  `GET /api/pages/[id]/notes` — same merge pattern (board preserves
  `z ASC, createdAt ASC`; trash flag is passed through so trash views never
  leak live backup rows).
- `GET /api/notes/search?q=` — TiDB (`contains`, LIKE-escaped) + CockroachDB
  (`contains`, LIKE-escaped) merged, deduped by id, re-sorted newest-first,
  top 30.
- `GET /api/storage` — COUNT/SUM telemetry (30s cache) + shift status +
  replication stats + count divergence + opportunistic replication flush.
  Honesty contract: CockroachDB + users-cluster bytes are measured content
  sums (`bytesMeasured:true`); TiDB bytes are LENGTH()+allowance estimates
  (`bytesMeasured:false`, `method:"length-sum-estimate"`) because Serverless
  exposes no billed-size probe. Tables carry live/tombstoned splits
  (`pagesLive`/`pagesTombstoned`) — headline counts include tombstones.
  Quotas are documented plan defaults (`tidb-starter-5gib-row-default`,
  `cockroachdb-cloud-basic-10gib-default`) unless overridden via
  `*_QUOTA_BYTES` env vars; users-cluster quota is excluded from the
  combined total (labeled in `overall.quotaNote`).
- `GET /api/health` — liveness/latency per engine + shift status + activity
  logs (generic errors only; topology redacted).

## 4. Write flows

### Pages
- `POST /api/pages {bookId, afterPageNumber?, title?, content?}`
  sanitizes HTML server-side, clamps `after`, runs renumber+insert in **one
  Prisma transaction** (negate trick, tombstones excluded), retries the
  **whole tx once** on contention (`P2002`/9007/deadlock), shifts margin
  notes after commit (`notesSyncOk` flag), replicates to CockroachDB (queued
  on failure), idempotency key bound to body hash (`x-idempotency-key`,
  10 min). Max 2000 pages/book. 415 on non-JSON content type.
- `PATCH /api/pages/[id]` — empty patch → 400; tombstoned/missing → 404
  (never fails over into a wrong engine for validation errors).
- `DELETE /api/pages/[id][?sweep=1]` — **soft delete**: tombstone at a
  unique negative number + live rows above decrement (one tx) + margin notes
  soft-shifted. `?sweep=1` additionally refuses non-blank/pinned/titled
  pages with 409 (server backstop against stale clients).

### Auto-delete (sweeper) — `sweepEmptyPages`, `BookApp.tsx`
A page is auto-removed only if **all** hold: number > 0, unpinned,
`isBlankHtml(content)` (markup residue like `<p><br></p>` counts as blank),
empty title, not on screen, past the 60s fresh grace — re-validated live
before **each** DELETE (never from a stale snapshot), one at a time, display
re-corrected afterwards (`correctDisplayAfterShrink`). Runs 1.5s after
landing on a spread and on book close.

### Autosave — `PageFace` → `BookApp.savePage`
700ms debounce → `PATCH` (15s timeout). Optimistic UI + `pendingEdits`
overlay: any server list landing mid-flight is merged over unsaved drafts, so
typing can never be clobbered; drafts clear only on successful save (404
reconciles from server). Flush ownership guard prevents writing page A's
words into page B after a fast turn.

### Board & margin notes
- Board CRUD + trash/restore; `POST` z-allocated atomically in both engines
  (`SELECT COALESCE(MAX(z),0)+1 … FOR UPDATE` inside the insert tx);
  coords/sizes clamped identically in both engines; per-note color only
  affects stickies (cards are fixed cream).
- Trash: soft-delete → restore, or **purge** (`DELETE …?hard=1`, trashed-only
  or 409) / **empty all** (`DELETE /api/board?emptyTrash=1`, explicit flag or
  400). Purges replicate to CockroachDB (idempotent; queued on failure).
- Margin notes: per-page CRUD + trash/restore; creation idempotent (key+hash).

## 5. Storage engine: shift, replication, backup

- **Dynamic shift** (`shouldShiftToTurso`, `getStorageShiftStatus`): per-domain
  remaining-bytes = operator override (`TIDB_*_REMAINING_BYTES`) → live
  `information_schema` probe (60s cache, fire-and-forget refresh) → ~5GB
  default. Under 10MB remaining (1MB critical) writes route straight to
  CockroachDB; `quotaSource` (`override|probe|default`) is always reported.
- **Failover** (`withStorageShift`): connection/storage errors fall over to
  CockroachDB; validation/constraint/notrash/flyleaf/sweep-refusal errors
  **never** fork (`isNonFailoverError`); double-miss surfaces the backup
  404. Replies carry the owning engine for the activity log.
- **Replication** (best-effort dual-write + retry queue): failures enqueue
  (cap 500, exp backoff, 10 attempts, drop counter), flushed
  opportunistically on storage reads; `board-note-purge` and page-tombstone
  mirrors included so deletes propagate instead of ghosting.
- **Backup** (`POST /api/backup`): full TiDB→CockroachDB snapshot in
  200-row `$transaction` chunks (tombstones included — a snapshot must never
  untombstone).
- **Restore** (`POST /api/backup?action=restore`, requires
  `{"confirm":"RESTORE"}`): last-write-wins per row; stale rows skipped
  (`skippedAsStale`); tombstoned rows stay dead (`skippedTombstoned`) unless
  `force:true`, which resurrects pages appended after the last live page.
- **Repair/prune** (`POST /api/storage`): `{"action":"repair"}` re-snapshots;
  `{"action":"prune","olderThanDays":N}` hard-deletes old tombstones in both
  engines + expires 30-day `system_logs`. Both destructive-gated + rate-limited.

## 6. Cross-cutting controls

- **CSRF**: `src/middleware.ts` on all non-GET `/api/*` — rejects a present
  but host-mismatched `Origin`/`Referer` (403); headerless clients pass.
- **Rate limiting** (`src/lib/rate-limit.ts`): 120/60/10 per min (read/write/
  destructive, limit-first incl. before auth); Upstash Redis when configured,
  memory fallback; **destructive budgets fail closed** when Redis is
  configured but unreachable; `x-real-ip` preferred over `x-forwarded-for`.
- **XSS**: allowlist sanitizer, mirrored server (`sanitize.ts`) + client
  (`PageFace`): dangerous tags/attrs/`javascript:`/inline `style` stripped,
  headings downgraded to `h3`, `span`/`font` unwrapped, old escaped spans
  healed, only `ink-hl*` palette classes survive on `<mark>`. CSP enforced in
  prod via `next.config.ts` (`unsafe-inline` still required by Next.js
  bootstrap — sanitizer is the real defense). Board/notes render as text.
- **Validation**: id length caps, 20k content / 200 title caps, color/type
  allowlists, numeric clamps, `take` caps, `MAX_PAGES_PER_BOOK = 2000`.
- **Observability**: every mutation logs to CockroachDB `system_logs`
  (sanitized, truncated); health/storage dashboards; divergence counters.

## 7. Frontend architecture notes

- `BookApp` owns book/pages/notes state; `BookStage` owns spread/sheet math
  (`sheet = page/2`, single mode `sheet = page`) with idle shrink-clamp +
  `goToPage` clamping; display corrections flow stage-ward only.
- `PageFace` instances are **reused across flips** (same tree slot, new page
  prop) — hence `pageIdRef`/`draftRef`/flush-ownership guards; toolbar is
  portaled to `document.body` (fixed positioning breaks inside the 3D rig).
- Mobile: single-page stage <640px; toolbar wraps; 44px resize hit area;
  timeouts + toasts on every network path (no silent hangs).
- Fonts: local woff2 only (no Google Fonts link — would violate prod CSP).

## 8. Operations

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | dev :3000 / prod build / prod serve |
| `npm test` | vitest unit suite — DB-free (sanitizer, limiter, failover rules, CSRF, identity), 63 tests |
| `npm run lint` | eslint (`scripts/` ignored by config) |
| `npm run db:push` / `db:generate` | push Prisma schemas + regen clients (all four engines) |
| `npm run db:push:backup` | push the CockroachDB backup schema + regen its client |
| `npm run seed` | stable-id upsert of printed pages (never wipes); guarded by `ALLOW_DESTRUCTIVE_SCRIPT=1` (same guard: `clear-notes`, `restore-demo`) |
| `npm run backup:*` | init / run / restore / status against CockroachDB (live-DB scripts, **not** CI; `turso:*` aliases are historical names) |

Env essentials: `BOOKS/NOTES_DATABASE_URL`, `USERS_DATABASE_URL`,
`BACKUP_DATABASE_URL`, `USRINFO_*` (dead — Turso decommissioned), optional
`ADMIN_TOKEN` (≥16 chars; unset = public), `TIDB_QUOTA_BYTES`,
`BACKUP_QUOTA_BYTES` (default: CockroachDB Cloud Basic free 10 GiB),
`USERS_QUOTA_BYTES` (default: TiDB Starter 5 GiB),
`TIDB_*_REMAINING_BYTES` overrides, `UPSTASH_REDIS_*`,
`ALLOW_DESTRUCTIVE_SCRIPT`.
Never commit `.env*` (gitignored); never `NEXT_PUBLIC_*` a secret.

## 9. Invariants for future changes

1. Tombstoned pages stay invisible everywhere; only `prune` (explicit) or `force` restore touches them.
2. Renumber paths must exclude `deletedAt IS NOT NULL` (both engines, both directions).
3. Validation errors never fail over; double-miss → 404.
4. Server lists merge over `pendingEdits`, never overwrite them.
5. Idempotency keys bind to body hash; one key per user intent on the client.
6. Sanitizer copies (server/client) change together — `npm test` parity cases enforce it.
7. No `NEXT_PUBLIC_*` secrets; destructive endpoints keep confirm + limit-first.
