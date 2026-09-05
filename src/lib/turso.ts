import { dbBooks, dbNotes } from './db'
import { dbBackup } from './db-backup'
import { isBlankHtml, escapeLikeWildcards } from './sanitize'
import { SWEEP_MIN_AGE_MS } from './identity'

/**
 * Backup-engine front: CockroachDB via Prisma. Export names are historical
 * (turso*, isTursoConfigured, getTursoBackupStats, …) so the 15 API call
 * sites keep working untouched — but every byte below now goes to
 * CockroachDB. The old Turso backup database is decommissioned; usernames,
 * presence and page leases live in src/lib/usrinfo.ts (separate Turso DB).
 */

export function isTursoConfigured(): boolean {
  return Boolean(process.env.BACKUP_DATABASE_URL)
}

/**
 * Legacy no-op kept for existing call sites: the CockroachDB schema is
 * managed by `prisma db push --schema prisma/schema-backup.prisma`.
 */
export async function initTursoTables(): Promise<void> {
  return
}

export interface BackupStats {
  configured: boolean
  lastBackupAt: string | null
  booksCount: number
  pagesCount: number
  pageNotesCount: number
  boardNotesCount: number
  /** Redacted presence flags — never leak raw connection URLs (L-5). */
  databaseUrl: string
  notesDatabaseUrl: string
}

function maskDbUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    const host = u.hostname || ''
    // keep only generic shape, drop credentials/subdomain details
    if (!host) return 'configured'
    const parts = host.split('.')
    const suffix = parts.slice(-2).join('.')
    return `${u.protocol}//***.${suffix}`
  } catch {
    return 'configured'
  }
}

/**
 * Get current row counts and metadata from the CockroachDB backup database.
 */
export async function getTursoBackupStats(): Promise<BackupStats> {
  if (!isTursoConfigured()) {
    return {
      configured: false,
      lastBackupAt: null,
      booksCount: 0,
      pagesCount: 0,
      pageNotesCount: 0,
      boardNotesCount: 0,
      databaseUrl: '',
      notesDatabaseUrl: '',
    }
  }

  try {
    const [booksCount, pagesCount, pageNotesCount, boardNotesCount, meta] = await Promise.all([
      dbBackup.backupBook.count(),
      dbBackup.backupPage.count(),
      dbBackup.backupPageNote.count(),
      dbBackup.backupBoardNote.count(),
      dbBackup.backupMeta.findUnique({ where: { key: 'last_backup_at' } }),
    ])

    return {
      configured: true,
      lastBackupAt: meta?.value ?? null,
      booksCount,
      pagesCount,
      pageNotesCount,
      boardNotesCount,
      databaseUrl: maskDbUrl(process.env.BACKUP_DATABASE_URL || ''),
      notesDatabaseUrl: maskDbUrl(process.env.BACKUP_DATABASE_URL || ''),
    }
  } catch (error) {
    console.error('Error querying backup stats:', error)
    return {
      configured: true,
      lastBackupAt: null,
      booksCount: 0,
      pagesCount: 0,
      pageNotesCount: 0,
      boardNotesCount: 0,
      databaseUrl: 'configured',
      notesDatabaseUrl: 'configured',
    }
  }
}

/**
 * Backup-engine quota: operator override first, otherwise the CockroachDB
 * Cloud Basic free allowance (10 GiB/month, per cockroachlabs.com/pricing —
 * verified 2026; Basic caps at 3 TiB with the first 10 GiB free). The default
 * is a documented plan value, NOT a measurement — set BACKUP_QUOTA_BYTES if
 * the cluster is on a paid plan so the dashboard never shows a fake ceiling.
 */
export const BACKUP_QUOTA_BYTES_DEFAULT = 10 * 1024 * 1024 * 1024

export function getBackupQuotaBytes(): number {
  const raw = Number(process.env.BACKUP_QUOTA_BYTES || 0)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return BACKUP_QUOTA_BYTES_DEFAULT
}

export interface BackupDiskUsage {
  ok: boolean
  latencyMs: number
  /** Real stored-content bytes per table, measured with octet_length sums. */
  bytesByTable: {
    books: number
    pages: number
    pageNotes: number
    boardNotes: number
    systemLogs: number
    backupMeta: number
  }
  totalBytes: number
}

/**
 * REAL backup-engine usage — measured from CockroachDB itself, never
 * estimated from row counts. Each table contributes SUM(octet_length(...))
 * over its text columns plus a fixed per-row allowance for the scalar
 * columns (ints/floats/bools/timestamps/row header). This is stored-content
 * bytes, not filesystem bytes: CockroachDB Cloud exposes no per-table
 * disk-size function to non-admin users (`pg_total_relation_size` and
 * `crdb_internal.table_span_stats` are both unavailable), so content bytes
 * is the honest measurable number. Falls back to ok:false so callers show
 * "unmeasured" instead of a fabricated number.
 */
export async function getBackupDiskUsage(): Promise<BackupDiskUsage> {
  const start = Date.now()
  const zero = {
    books: 0,
    pages: 0,
    pageNotes: 0,
    boardNotes: 0,
    systemLogs: 0,
    backupMeta: 0,
  }
  if (!isTursoConfigured()) {
    return { ok: false, latencyMs: 0, bytesByTable: zero, totalBytes: 0 }
  }
  // Fixed per-row allowance for non-text columns + row overhead.
  const ROW = 128
  try {
    const [books, pages, pageNotes, boardNotes, systemLogs, backupMeta] = await Promise.all([
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(id) + octet_length(title) + octet_length(COALESCE(subtitle,'')) + octet_length(author) + octet_length(COALESCE(description,'')) + octet_length("coverTheme")), 0) AS b,
               COUNT(*) AS n FROM "books"`,
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(id) + octet_length("bookId") + octet_length(title) + octet_length(section) + octet_length(content)), 0) AS b,
               COUNT(*) AS n FROM "pages"`,
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(id) + octet_length("bookId") + octet_length("pageId") + octet_length(content) + octet_length(color)), 0) AS b,
               COUNT(*) AS n FROM "page_notes"`,
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(id) + octet_length(content) + octet_length(color) + octet_length(type)), 0) AS b,
               COUNT(*) AS n FROM "board_notes"`,
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(id) + octet_length(timestamp) + octet_length("timeFormatted") + octet_length(action) + octet_length(title) + octet_length(details) + octet_length(engine) + octet_length(level)), 0) AS b,
               COUNT(*) AS n FROM "system_logs"`,
      dbBackup.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(octet_length(key) + octet_length(value) + octet_length("updatedAt")), 0) AS b,
               COUNT(*) AS n FROM "backup_meta"`,
    ])
    const sized = (r: { b: bigint | number | null; n: bigint | number | null } | undefined) =>
      Number(r?.b ?? 0) + Number(r?.n ?? 0) * ROW
    const bytesByTable = {
      books: sized(books?.[0]),
      pages: sized(pages?.[0]),
      pageNotes: sized(pageNotes?.[0]),
      boardNotes: sized(boardNotes?.[0]),
      systemLogs: sized(systemLogs?.[0]),
      backupMeta: sized(backupMeta?.[0]),
    }
    const totalBytes = Object.values(bytesByTable).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0)
    return { ok: true, latencyMs: Date.now() - start, bytesByTable, totalBytes }
  } catch (error) {
    console.warn('[turso] backup disk usage probe failed:', (error as any)?.message || error)
    return { ok: false, latencyMs: Date.now() - start, bytesByTable: zero, totalBytes: 0 }
  }
}

/**
 * Perform a full snapshot backup from TiDB into CockroachDB.
 */
export async function backupAllToTurso(): Promise<{
  success: boolean
  stats: {
    books: number
    pages: number
    pageNotes: number
    boardNotes: number
    timestamp: string
  }
}> {
  await initTursoTables()

  // 1. Fetch from TiDB
  const [books, pages] = await Promise.all([
    dbBooks.book.findMany(),
    dbBooks.page.findMany({ orderBy: { pageNumber: 'asc' } }),
  ])

  const [pageNotes, boardNotes] = await Promise.all([
    dbNotes.pageNote.findMany(),
    dbNotes.boardNote.findMany(),
  ])

  const nowIso = new Date().toISOString()

  // Upsert into CockroachDB in bounded $transaction chunks (200 rows each):
  // same spirit as the old chunked batches — no unbounded round trip.
  // deletedAt is always written so tombstones propagate (never untombstone).
  const upsertChunked = async <T>(rows: T[], fn: (chunk: T[]) => Promise<unknown>) => {
    // Sequential chunks by design: bounded memory + ordered writes.
    for (let i = 0; i < rows.length; i += 200) {
      await fn(rows.slice(i, i + 200))
    }
  }

  await upsertChunked(books, (chunk) =>
    dbBackup.$transaction(
      chunk.map((b) =>
        dbBackup.backupBook.upsert({
          where: { id: b.id },
          create: {
            id: b.id,
            title: b.title,
            subtitle: b.subtitle,
            author: b.author,
            description: b.description,
            coverTheme: b.coverTheme,
            lastPage: b.lastPage,
            createdAt: b.createdAt,
            updatedAt: b.updatedAt,
          },
          update: {
            title: b.title,
            subtitle: b.subtitle,
            author: b.author,
            description: b.description,
            coverTheme: b.coverTheme,
            lastPage: b.lastPage,
            updatedAt: b.updatedAt,
          },
        })
      )
    )
  )

  await upsertChunked(pages, (chunk) =>
    dbBackup.$transaction(
      chunk.map((p) =>
        dbBackup.backupPage.upsert({
          where: { id: p.id },
          create: {
            id: p.id,
            bookId: p.bookId,
            pageNumber: p.pageNumber,
            chapter: p.chapter,
            section: p.section,
            title: p.title,
            content: p.content,
            pinned: p.pinned,
            deletedAt: p.deletedAt,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          },
          update: {
            bookId: p.bookId,
            pageNumber: p.pageNumber,
            chapter: p.chapter,
            section: p.section,
            title: p.title,
            content: p.content,
            pinned: p.pinned,
            deletedAt: p.deletedAt,
            updatedAt: p.updatedAt,
          },
        })
      )
    )
  )

  await upsertChunked(pageNotes, (chunk) =>
    dbBackup.$transaction(
      chunk.map((n) =>
        dbBackup.backupPageNote.upsert({
          where: { id: n.id },
          create: {
            id: n.id,
            bookId: n.bookId,
            pageId: n.pageId,
            pageNumber: n.pageNumber,
            content: n.content,
            color: n.color,
            deletedAt: n.deletedAt,
            createdAt: n.createdAt,
            updatedAt: n.updatedAt,
          },
          update: {
            bookId: n.bookId,
            pageId: n.pageId,
            pageNumber: n.pageNumber,
            content: n.content,
            color: n.color,
            deletedAt: n.deletedAt,
            updatedAt: n.updatedAt,
          },
        })
      )
    )
  )

  await upsertChunked(boardNotes, (chunk) =>
    dbBackup.$transaction(
      chunk.map((bn) =>
        dbBackup.backupBoardNote.upsert({
          where: { id: bn.id },
          create: {
            id: bn.id,
            content: bn.content,
            color: bn.color,
            type: bn.type,
            x: bn.x,
            y: bn.y,
            width: bn.width,
            height: bn.height,
            rotation: bn.rotation,
            z: bn.z,
            pinned: bn.pinned,
            deletedAt: bn.deletedAt,
            createdAt: bn.createdAt,
            updatedAt: bn.updatedAt,
          },
          update: {
            content: bn.content,
            color: bn.color,
            type: bn.type,
            x: bn.x,
            y: bn.y,
            width: bn.width,
            height: bn.height,
            rotation: bn.rotation,
            z: bn.z,
            pinned: bn.pinned,
            deletedAt: bn.deletedAt,
            updatedAt: bn.updatedAt,
          },
        })
      )
    )
  )

  await dbBackup.backupMeta.upsert({
    where: { key: 'last_backup_at' },
    create: { key: 'last_backup_at', value: nowIso, updatedAt: nowIso },
    update: { value: nowIso, updatedAt: nowIso },
  })

  return {
    success: true,
    stats: {
      books: books.length,
      pages: pages.length,
      pageNotes: pageNotes.length,
      boardNotes: boardNotes.length,
      timestamp: nowIso,
    },
  }
}

/**
 * Restore data from CockroachDB backup into TiDB clusters.
 * Last-Write-Wins (M-4): a backup row only overwrites live TiDB data when the
 * backup `updatedAt` is newer (or the live row is missing). This prevents a
 * stale snapshot from silently clobbering fresh edits or resurrecting deletes
 * unless the caller explicitly forces it. Deleted-in-TiDB rows are NOT
 * resurrected when live data is newer.
 */
export async function restoreAllFromTurso(opts?: {
  force?: boolean
}): Promise<{
  success: boolean
  restored: {
    books: number
    pages: number
    pageNotes: number
    boardNotes: number
  }
  skippedAsStale: number
  skippedTombstoned: number
}> {
  const force = Boolean(opts?.force)
  const [backupBooks, backupPages] = await Promise.all([
    dbBackup.backupBook.findMany(),
    dbBackup.backupPage.findMany({ orderBy: { pageNumber: 'asc' } }),
  ])

  const [backupPageNotes, backupBoardNotes] = await Promise.all([
    dbBackup.backupPageNote.findMany(),
    dbBackup.backupBoardNote.findMany(),
  ])

  let skippedAsStale = 0
  let skippedTombstoned = 0
  // Actual upserts per table (P3): `restored` must not count stale skips.
  let rBooks = 0
  let rPages = 0
  let rPageNotes = 0
  let rBoardNotes = 0
  const isBackupNewer = (backupIso: unknown, live: Date | null | undefined) => {
    if (force) return true
    if (!live) return true
    const b = new Date(String(backupIso)).getTime()
    if (Number.isNaN(b)) return true
    return b >= live.getTime()
  }

  // Restore Books & Pages to TiDB
  for (const row of backupBooks) {
    const id = String(row.id)
    const live = await dbBooks.book.findUnique({ where: { id }, select: { updatedAt: true } })
    if (!isBackupNewer(row.createdAt && row.updatedAt ? row.updatedAt : row.createdAt, live?.updatedAt)) {
      skippedAsStale += 1
      continue
    }
    await dbBooks.book.upsert({
      where: { id },
      create: {
        id,
        title: String(row.title),
        subtitle: row.subtitle ? String(row.subtitle) : null,
        author: String(row.author),
        description: row.description ? String(row.description) : null,
        coverTheme: String(row.coverTheme || 'emerald'),
        lastPage: Number(row.lastPage || 1),
        createdAt: new Date(String(row.createdAt)),
        updatedAt: new Date(String(row.updatedAt)),
      },
      update: {
        title: String(row.title),
        subtitle: row.subtitle ? String(row.subtitle) : null,
        author: String(row.author),
        description: row.description ? String(row.description) : null,
        coverTheme: String(row.coverTheme || 'emerald'),
        lastPage: Number(row.lastPage || 1),
      },
    })
    rBooks += 1
  }

  // Pages: skip stale + guard duplicate pageNumbers (M-1) so a half-restored
  // book can't abort midway on @@unique violations. Tombstoned backup rows
  // stay dead unless forced — otherwise every restore resurrects deletions.
  const livePages = await dbBooks.page.findMany({ select: { id: true, bookId: true, pageNumber: true, updatedAt: true, deletedAt: true } })
  const liveById = new Map(livePages.map((p) => [p.id, p]))
  const takenNumbers = new Set(livePages.map((p) => `${p.bookId}:${p.pageNumber}`))
  const liveMaxByBook = new Map<string, number>()
  for (const p of livePages) {
    if (p.pageNumber > 0) liveMaxByBook.set(p.bookId, Math.max(liveMaxByBook.get(p.bookId) ?? 0, p.pageNumber))
  }
  for (const row of backupPages) {
    const id = String(row.id)
    const live = liveById.get(id)
    const backupTombstoned = Boolean((row as any).deletedAt)
    if (backupTombstoned && !force) {
      skippedTombstoned += 1
      continue
    }
    // A live tombstone stands unless the backup row is genuinely newer than
    // the deletion itself — otherwise restore would undo every delete.
    if (live?.deletedAt && !force) {
      const liveTime = live.updatedAt.getTime()
      const backupTime = new Date(String(row.updatedAt)).getTime()
      if (!(backupTime > liveTime)) {
        skippedTombstoned += 1
        continue
      }
    }
    if (!isBackupNewer(row.updatedAt, live?.updatedAt)) {
      skippedAsStale += 1
      continue
    }
    // Forced resurrection of a tombstone: append after the last live page so
    // it can never collide or disturb current numbering.
    let targetNumber = Number(row.pageNumber)
    let targetDeletedAt: Date | null = row.deletedAt ? new Date(String(row.deletedAt)) : null
    if (backupTombstoned && force) {
      const bookMax = liveMaxByBook.get(String(row.bookId)) ?? 0
      targetNumber = bookMax + 1
      liveMaxByBook.set(String(row.bookId), targetNumber)
      targetDeletedAt = null
    }
    const key = `${String(row.bookId)}:${targetNumber}`
    if (!live && takenNumbers.has(key)) {
      console.warn(`[restore] skipping page ${id}: pageNumber collision at ${key}`)
      skippedAsStale += 1
      continue
    }
    try {
      await dbBooks.page.upsert({
        where: { id },
        create: {
          id,
          bookId: String(row.bookId),
          pageNumber: targetNumber,
          chapter: Number(row.chapter || 1),
          section: String(row.section),
          title: String(row.title),
          content: String(row.content),
          pinned: Boolean(row.pinned),
          deletedAt: targetDeletedAt,
          createdAt: new Date(String(row.createdAt)),
          updatedAt: new Date(String(row.updatedAt)),
        },
        update: {
          pageNumber: targetNumber,
          chapter: Number(row.chapter || 1),
          section: String(row.section),
          title: String(row.title),
          content: String(row.content),
          pinned: Boolean(row.pinned),
          deletedAt: targetDeletedAt,
        },
      })
      takenNumbers.add(key)
      rPages += 1
    } catch (e: any) {
      if (String((e as any)?.code || '') === 'P2002') {
        console.warn(`[restore] pageNumber collision for ${id}, skipped`)
        skippedAsStale += 1
        continue
      }
      throw e
    }
  }

  // Restore Notes to TiDB (LWW)
  for (const row of backupPageNotes) {
    const id = String(row.id)
    const live = await dbNotes.pageNote.findUnique({ where: { id }, select: { updatedAt: true } })
    if (!isBackupNewer(row.updatedAt, live?.updatedAt)) {
      skippedAsStale += 1
      continue
    }
    await dbNotes.pageNote.upsert({
      where: { id },
      create: {
        id,
        bookId: String(row.bookId),
        pageId: String(row.pageId),
        pageNumber: Number(row.pageNumber),
        content: String(row.content),
        color: String(row.color || 'amber'),
        deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
        createdAt: new Date(String(row.createdAt)),
        updatedAt: new Date(String(row.updatedAt)),
      },
      update: {
        content: String(row.content),
        color: String(row.color || 'amber'),
        deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
      },
    })
    rPageNotes += 1
  }

  for (const row of backupBoardNotes) {
    const id = String(row.id)
    const live = await dbNotes.boardNote.findUnique({ where: { id }, select: { updatedAt: true } })
    if (!isBackupNewer(row.updatedAt, live?.updatedAt)) {
      skippedAsStale += 1
      continue
    }
    await dbNotes.boardNote.upsert({
      where: { id },
      create: {
        id,
        content: String(row.content),
        color: String(row.color || 'amber'),
        type: String(row.type || 'sticky'),
        x: Number(row.x || 120),
        y: Number(row.y || 120),
        width: Number(row.width || 240),
        height: Number(row.height || 240),
        rotation: Number(row.rotation || 0),
        z: Number(row.z || 0),
        pinned: Boolean(row.pinned),
        deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
        createdAt: new Date(String(row.createdAt)),
        updatedAt: new Date(String(row.updatedAt)),
      },
      update: {
        content: String(row.content),
        color: String(row.color || 'amber'),
        type: String(row.type || 'sticky'),
        x: Number(row.x || 120),
        y: Number(row.y || 120),
        width: Number(row.width || 240),
        height: Number(row.height || 240),
        rotation: Number(row.rotation || 0),
        z: Number(row.z || 0),
        pinned: Boolean(row.pinned),
        deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
      },
    })
    rBoardNotes += 1
  }

  return {
    success: true,
    restored: {
      books: rBooks,
      pages: rPages,
      pageNotes: rPageNotes,
      boardNotes: rBoardNotes,
    },
    skippedAsStale,
    skippedTombstoned,
  }
}

// --------------------------------------------------------------------------
// Replication retry queue + divergence detection (H-4/H-5 follow-up).
// Dual-writes used to fail silently (warn-only). Failures are now queued
// (capped, exp backoff, max attempts) and retried opportunistically on
// subsequent requests (serverless-safe: no background timers). Divergence
// counts are computed from telemetry the storage endpoint already fetches.
// --------------------------------------------------------------------------

export type ReplicationKind =
  | 'page-upsert'
  | 'page-delete'
  | 'note-upsert'
  | 'page-note-delete'
  | 'board-note-delete'
  | 'board-note-purge'

interface ReplicationRetry {
  kind: ReplicationKind
  payload: any
  attempts: number
  nextAt: number
}

const globalForRepl = globalThis as unknown as {
  __librisReplQueue?: ReplicationRetry[]
  __librisReplFlushing?: boolean
  __librisReplDropped?: number
  __librisReplLastFlushAt?: string | null
}

const REPL_QUEUE_MAX = 500
const REPL_MAX_ATTEMPTS = 10

function replQueue(): ReplicationRetry[] {
  if (!globalForRepl.__librisReplQueue) globalForRepl.__librisReplQueue = []
  return globalForRepl.__librisReplQueue
}

export function enqueueReplicationFailure(kind: ReplicationKind, payload: any): void {
  const q = replQueue()
  if (q.length >= REPL_QUEUE_MAX) {
    q.shift()
    globalForRepl.__librisReplDropped = (globalForRepl.__librisReplDropped ?? 0) + 1
  }
  q.push({ kind, payload, attempts: 0, nextAt: Date.now() + 5000 })
}

function backoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 5000 * Math.pow(2, Math.min(attempts, 5)))
}

/** Delete-retry payloads carry the soft flag (N2); tolerate legacy plain ids. */
function normalizeDeletePayload(payload: any): { noteId: string; soft: boolean } {
  if (typeof payload === 'string') return { noteId: payload, soft: true }
  return { noteId: String(payload?.noteId ?? payload), soft: payload?.soft !== false }
}

/** Retry due queue entries. Fire-and-forget safe; never throws. */
export async function flushReplicationQueue(limit = 50): Promise<{ retried: number; pending: number }> {
  if (!isTursoConfigured() || globalForRepl.__librisReplFlushing) {
    return { retried: 0, pending: replQueue().length }
  }
  globalForRepl.__librisReplFlushing = true
  let retried = 0
  try {
    await initTursoTables().catch(() => {})
    const q = replQueue()
    const now = Date.now()
    const due = q.filter((e) => e.nextAt <= now).slice(0, limit)
    for (const entry of due) {
      const idx = q.indexOf(entry)
      if (idx >= 0) q.splice(idx, 1)
      try {
        switch (entry.kind) {
          case 'page-upsert':
            await tursoDirectPageUpsert(entry.payload)
            break
          case 'page-delete': {
            const delId =
              typeof entry.payload === 'string' ? entry.payload : String(entry.payload?.noteId ?? entry.payload)
            const row = await dbBackup.backupPage.findUnique({ where: { id: delId } })
            if (row && !row.deletedAt && row.pageNumber > 0) {
              await dbBackup.backupPage.update({
                where: { id: delId },
                data: {
                  deletedAt: new Date(),
                  pageNumber: await backupTombNumber(row.bookId, row.pageNumber),
                },
              })
            }
            break
          }
          case 'note-upsert':
            await replicateNoteUpsertNow(entry.payload)
            break
          case 'page-note-delete': {
            const p = normalizeDeletePayload(entry.payload)
            if (p.soft) {
              await tursoDeletePageNote(p.noteId)
            } else {
              await dbBackup.backupPageNote.deleteMany({ where: { id: p.noteId } })
            }
            break
          }
          case 'board-note-delete': {
            const p = normalizeDeletePayload(entry.payload)
            if (p.soft) {
              await tursoDeleteBoardNote(p.noteId)
            } else {
              await dbBackup.backupBoardNote.deleteMany({ where: { id: p.noteId } })
            }
            break
          }
          case 'board-note-purge': {
            // Hard delete is idempotent: missing row = already purged.
            await dbBackup.backupBoardNote.deleteMany({ where: { id: String(entry.payload) } })
            break
          }
        }
        retried += 1
      } catch {
        entry.attempts += 1
        if (entry.attempts >= REPL_MAX_ATTEMPTS) {
          globalForRepl.__librisReplDropped = (globalForRepl.__librisReplDropped ?? 0) + 1
          console.error(`[replicate] dropping ${entry.kind} after ${REPL_MAX_ATTEMPTS} attempts`)
        } else {
          entry.nextAt = Date.now() + backoffMs(entry.attempts)
          q.push(entry)
        }
      }
    }
    globalForRepl.__librisReplLastFlushAt = new Date().toISOString()
  } finally {
    globalForRepl.__librisReplFlushing = false
  }
  return { retried, pending: replQueue().length }
}

export function getReplicationStats() {
  return {
    queued: replQueue().length,
    dropped: globalForRepl.__librisReplDropped ?? 0,
    lastFlushAt: globalForRepl.__librisReplLastFlushAt ?? null,
  }
}

/** Direct page upsert used by retries (throws on failure, unlike replicatePageUpsert). */
async function tursoDirectPageUpsert(page: any): Promise<void> {
  await upsertBackupPageNow(page)
}

/** Direct note upsert used by retries (throws on failure). */
async function replicateNoteUpsertNow(note: any): Promise<void> {
  await upsertBackupNoteNow(note)
}

export interface DivergenceTable {
  table: string
  tidb: number
  turso: number
  delta: number
}

/** Cheap divergence signal from counts the storage endpoint already has. */
export function buildDivergence(
  tidb: { books: number; pages: number; pageNotes: number; boardNotes: number },
  turso: { books: number; pages: number; pageNotes: number; boardNotes: number }
): { diverged: boolean; tables: DivergenceTable[] } {
  const tables: DivergenceTable[] = (
    [
      ['books', tidb.books, turso.books],
      ['pages', tidb.pages, turso.pages],
      ['pageNotes', tidb.pageNotes, turso.pageNotes],
      ['boardNotes', tidb.boardNotes, turso.boardNotes],
    ] as Array<[string, number, number]>
  ).map(([table, t, u]) => ({ table, tidb: t, turso: u, delta: t - u }))
  return { diverged: tables.some((t) => t.delta !== 0), tables }
}

/** Unique tombstone slot below any existing negative (shared helper). */
async function backupTombNumber(bookId: string, gone: number): Promise<number> {
  const agg = await dbBackup.backupPage.aggregate({
    where: { bookId, pageNumber: { lt: 0 } },
    _min: { pageNumber: true },
  })
  return Math.min(-gone, (agg._min.pageNumber ?? 0) - 1)
}

/** Throwing core shared by replicate + retry-flush (CockroachDB). */
async function upsertBackupPageNow(page: any): Promise<void> {
  const deletedAt = page.deletedAt ? new Date(page.deletedAt) : null;
  await dbBackup.backupPage.upsert({
    where: { id: String(page.id) },
    create: {
      id: String(page.id),
      bookId: String(page.bookId),
      pageNumber: Number(page.pageNumber),
      chapter: Number(page.chapter || 1),
      section: String(page.section ?? 'Writing'),
      title: String(page.title ?? ''),
      content: String(page.content ?? ''),
      pinned: Boolean(page.pinned),
      deletedAt,
      createdAt: page.createdAt ? new Date(page.createdAt) : new Date(),
      updatedAt: page.updatedAt ? new Date(page.updatedAt) : new Date(),
    },
    update: {
      bookId: String(page.bookId),
      pageNumber: Number(page.pageNumber),
      chapter: Number(page.chapter || 1),
      section: String(page.section ?? 'Writing'),
      title: String(page.title ?? ''),
      content: String(page.content ?? ''),
      pinned: Boolean(page.pinned),
      deletedAt,
      updatedAt: page.updatedAt ? new Date(page.updatedAt) : new Date(),
    },
  })
}

/** Mirror a page tombstone into the backup engine (never a hard DELETE). */
async function tombstoneBackupPageNow(pageId: string): Promise<void> {
  const id = String(pageId)
  const existing = await dbBackup.backupPage.findUnique({ where: { id } })
  if (!existing || existing.deletedAt || existing.pageNumber <= 0) return
  await dbBackup.backupPage.update({
    where: { id },
    data: {
      deletedAt: new Date(),
      pageNumber: await backupTombNumber(existing.bookId, existing.pageNumber),
    },
  })
}

/**
 * Non-blocking continuous replication: replicate a page upsert to the backup engine.
 */
export async function replicatePageUpsert(page: {
  id: string
  bookId: string
  pageNumber: number
  chapter?: number
  section: string
  title: string
  content: string
  pinned: boolean
  createdAt?: Date
  updatedAt?: Date
}): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    await upsertBackupPageNow(page)
  } catch (err) {
    console.warn('[turso] replicatePageUpsert error:', err)
    enqueueReplicationFailure('page-upsert', { ...page })
  }
}

/**
 * Non-blocking continuous replication: mirror a page tombstone into the
 * backup engine (soft-delete + negate, never a hard DELETE — the tombstone
 * must survive for merge/restore to agree the page is gone).
 */
export async function replicatePageDelete(pageId: string): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    await tombstoneBackupPageNow(pageId)
  } catch (err) {
    console.warn('[turso] replicatePageDelete error:', err)
    enqueueReplicationFailure('page-delete', pageId)
  }
}

/** Throwing core shared by replicate + retry-flush (CockroachDB). */
async function upsertBackupNoteNow(note: any): Promise<void> {
  const deletedAt = note.deletedAt ? new Date(note.deletedAt) : null;
  const createdAt = note.createdAt ? new Date(note.createdAt) : new Date();
  const updatedAt = note.updatedAt ? new Date(note.updatedAt) : new Date();
  if (note.isBoard) {
    await dbBackup.backupBoardNote.upsert({
      where: { id: String(note.id) },
      create: {
        id: String(note.id),
        content: String(note.content ?? ''),
        color: String(note.color || 'amber'),
        type: String(note.type || 'sticky'),
        x: Number(note.x ?? 120),
        y: Number(note.y ?? 120),
        width: Number(note.width ?? 240),
        height: Number(note.height ?? 240),
        rotation: Number(note.rotation ?? 0),
        z: Number(note.z ?? 0),
        pinned: Boolean(note.pinned),
        deletedAt,
        createdAt,
        updatedAt,
      },
      update: {
        content: String(note.content ?? ''),
        color: String(note.color || 'amber'),
        type: String(note.type || 'sticky'),
        x: Number(note.x ?? 120),
        y: Number(note.y ?? 120),
        width: Number(note.width ?? 240),
        height: Number(note.height ?? 240),
        rotation: Number(note.rotation ?? 0),
        z: Number(note.z ?? 0),
        pinned: Boolean(note.pinned),
        deletedAt,
        updatedAt,
      },
    })
  } else if (note.bookId && note.pageId && typeof note.pageNumber === 'number') {
    await dbBackup.backupPageNote.upsert({
      where: { id: String(note.id) },
      create: {
        id: String(note.id),
        bookId: String(note.bookId),
        pageId: String(note.pageId),
        pageNumber: Number(note.pageNumber),
        content: String(note.content ?? ''),
        color: String(note.color || 'amber'),
        deletedAt,
        createdAt,
        updatedAt,
      },
      update: {
        bookId: String(note.bookId),
        pageId: String(note.pageId),
        pageNumber: Number(note.pageNumber),
        content: String(note.content ?? ''),
        color: String(note.color || 'amber'),
        deletedAt,
        updatedAt,
      },
    })
  }
}

/**
 * Non-blocking continuous replication: replicate a note upsert to the backup engine.
 */
export async function replicateNoteUpsert(note: {
  id: string
  bookId?: string
  pageId?: string
  pageNumber?: number
  content: string
  color?: string
  type?: string
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
  z?: number
  pinned?: boolean
  deletedAt?: Date | null
  createdAt?: Date
  updatedAt?: Date
  isBoard?: boolean
}): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    await upsertBackupNoteNow(note)
  } catch (err) {
    console.warn('[turso] replicateNoteUpsert error:', err)
    enqueueReplicationFailure('note-upsert', { ...note })
  }
}

/**
 * Non-blocking continuous replication: replicate note deletion/soft-delete to CockroachDB.
 */
export async function replicateBoardNoteDelete(noteId: string, soft = true): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    if (soft) {
      await dbBackup.backupBoardNote.updateMany({
        where: { id: String(noteId), deletedAt: null },
        data: { deletedAt: new Date(), updatedAt: new Date() },
      })
    } else {
      await dbBackup.backupBoardNote.deleteMany({ where: { id: String(noteId) } })
    }
  } catch (err) {
    console.warn('[turso] replicateBoardNoteDelete error:', err)
    enqueueReplicationFailure('board-note-delete', { noteId, soft })
  }
}

export async function replicatePageNoteDelete(noteId: string, soft = true): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    if (soft) {
      await dbBackup.backupPageNote.updateMany({
        where: { id: String(noteId), deletedAt: null },
        data: { deletedAt: new Date(), updatedAt: new Date() },
      })
    } else {
      await dbBackup.backupPageNote.deleteMany({ where: { id: String(noteId) } })
    }
  } catch (err) {
    console.warn('[turso] replicatePageNoteDelete error:', err)
    enqueueReplicationFailure('page-note-delete', { noteId, soft })
  }
}

/**
 * Replicate a permanent purge to CockroachDB (trash emptying). Idempotent:
 * a missing row simply means already purged.
 */
export async function replicateBoardNotePurge(noteId: string): Promise<void> {
  if (!isTursoConfigured()) return
  try {
    await dbBackup.backupBoardNote.deleteMany({ where: { id: String(noteId) } })
  } catch (err) {
    console.warn('[turso] replicateBoardNotePurge error:', err)
    enqueueReplicationFailure('board-note-purge', noteId)
  }
}

/**
 * CockroachDB-side permanent purge of one trashed board note. Refuses live rows
 * so a stale client can never skip the trash.
 */
export async function tursoPurgeBoardNote(noteId: string): Promise<void> {
  await initTursoTables()
  const existing = await dbBackup.backupBoardNote.findUnique({ where: { id: String(noteId) } })
  if (!existing) throw new Error('Board note not found in Turso')
  if (!existing.deletedAt) {
    throw new Error('Move to trash first — only trashed notes can be purged')
  }
  await dbBackup.backupBoardNote.delete({ where: { id: String(noteId) } })
}

/**
 * CockroachDB-side permanent purge of ALL trashed board notes. Returns the count.
 */
export async function tursoPurgeBoardTrash(): Promise<{ purged: number }> {
  await initTursoTables()
  const res = await dbBackup.backupBoardNote.deleteMany({ where: { deletedAt: { not: null } } })
  return { purged: res.count }
}

// --------------------------------------------------------------------------
// Row mappers from backup-engine rows to API / Prisma shapes
// --------------------------------------------------------------------------

function mapBookRow(row: any) {
  return {
    id: String(row.id),
    title: String(row.title),
    subtitle: row.subtitle ? String(row.subtitle) : null,
    author: String(row.author),
    description: row.description ? String(row.description) : null,
    coverTheme: String(row.coverTheme || 'emerald'),
    lastPage: Number(row.lastPage || 1),
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

function mapPageRow(row: any) {
  return {
    id: String(row.id),
    bookId: String(row.bookId),
    pageNumber: Number(row.pageNumber),
    chapter: Number(row.chapter ?? 1),
    section: String(row.section),
    title: String(row.title),
    content: String(row.content),
    pinned: Boolean(row.pinned),
    deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

function mapBoardNoteRow(row: any) {
  return {
    id: String(row.id),
    content: String(row.content),
    color: String(row.color || 'amber'),
    type: String(row.type || 'sticky'),
    x: Number(row.x ?? 120),
    y: Number(row.y ?? 120),
    width: Number(row.width ?? 240),
    height: Number(row.height ?? 240),
    rotation: Number(row.rotation ?? 0),
    z: Number(row.z ?? 0),
    pinned: Boolean(row.pinned),
    deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

function mapPageNoteRow(row: any) {
  return {
    id: String(row.id),
    bookId: String(row.bookId),
    pageId: String(row.pageId),
    pageNumber: Number(row.pageNumber),
    content: String(row.content),
    color: String(row.color || 'amber'),
    deletedAt: row.deletedAt ? new Date(String(row.deletedAt)) : null,
    createdAt: new Date(String(row.createdAt)),
    updatedAt: new Date(String(row.updatedAt)),
  }
}

// --------------------------------------------------------------------------
// Dynamic Storage Shift Engine (< 10MB Fallback to CockroachDB)
// --------------------------------------------------------------------------

/**
 * 10MB Low-Storage Shift Threshold:
 * When TiDB has under 10MB remaining capacity,
 * all new writes (notes, books, pages) are DIRECTLY shifted to CockroachDB rather than TiDB.
 */
export const TIDB_LOW_STORAGE_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 Megabytes

/**
 * 1MB Critical Peak Threshold:
 * When TiDB has under 1MB remaining capacity (peak storage exhaustion),
 * high-priority emergency alerts are broadcast across UI and writes are immediately diverted.
 */
export const TIDB_CRITICAL_STORAGE_THRESHOLD_BYTES = 1 * 1024 * 1024 // 1 Megabyte

/** Assumed per-cluster quota unless TIDB_QUOTA_BYTES is set (NaN-safe). */
function parseQuotaBytes(): number {
  const fallback = 5 * 1024 * 1024 * 1024
  if (process.env.TIDB_QUOTA_BYTES == null || process.env.TIDB_QUOTA_BYTES === '') return fallback
  const n = Number(process.env.TIDB_QUOTA_BYTES)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
export const TIDB_QUOTA_BYTES = parseQuotaBytes()

// --------------------------------------------------------------------------
// Live quota probe: information_schema per cluster, 60s cache, env fallback.
// Call sites stay sync (serverless-safe): a stale cache or the old default is
// used while a background refresh runs. Explicit TIDB_*_REMAINING_BYTES env
// vars act as operator overrides (e.g. to force-test shift mode).
// --------------------------------------------------------------------------

interface QuotaSample {
  at: number
  booksUsed: number
  notesUsed: number
  booksOk: boolean
  notesOk: boolean
}

const globalForQuota = globalThis as unknown as { __librisQuota?: QuotaSample | null; __librisQuotaInflight?: boolean }

const QUOTA_CACHE_MS = 60_000
const DEFAULT_REMAINING_FALLBACK = 5368672212 // ~5GB, preserves legacy behavior when unprobed

function quotaOverride(domain: 'books' | 'notes'): number | null {
  const raw =
    domain === 'books' ? process.env.TIDB_BOOKS_REMAINING_BYTES : process.env.TIDB_NOTES_REMAINING_BYTES
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function probeOneCluster(kind: 'books' | 'notes'): Promise<{ used: number; ok: boolean }> {
  try {
    const rows =
      kind === 'books'
        ? await dbBooks.$queryRaw<Array<{ bytes: bigint | number | null }>>`
            SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
        : await dbNotes.$queryRaw<Array<{ bytes: bigint | number | null }>>`
            SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS bytes
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
    return { used: Number((rows?.[0] as any)?.bytes ?? 0), ok: true }
  } catch (e) {
    console.warn(`[quota] live probe failed for ${kind} cluster, using fallback`)
    return { used: 0, ok: false }
  }
}

/** Fire-and-forget refresh; safe to call from sync code paths. */
export function refreshQuotaCache(): void {
  if (globalForQuota.__librisQuotaInflight) return
  globalForQuota.__librisQuotaInflight = true
  void (async () => {
    try {
      const [b, n] = await Promise.all([probeOneCluster('books'), probeOneCluster('notes')])
      globalForQuota.__librisQuota = {
        at: Date.now(),
        booksUsed: b.used,
        notesUsed: n.used,
        booksOk: b.ok,
        notesOk: n.ok,
      }
    } finally {
      globalForQuota.__librisQuotaInflight = false
    }
  })()
}

function remainingFor(domain: 'books' | 'notes'): { remaining: number; source: 'override' | 'probe' | 'default'; used: number | null } {
  const override = quotaOverride(domain)
  if (override != null) return { remaining: override, source: 'override', used: TIDB_QUOTA_BYTES - override }

  const sample = globalForQuota.__librisQuota
  const fresh = sample && Date.now() - sample.at < QUOTA_CACHE_MS
  if (fresh) {
    const ok = domain === 'books' ? sample.booksOk : sample.notesOk
    const used = domain === 'books' ? sample.booksUsed : sample.notesUsed
    if (ok) return { remaining: Math.max(0, TIDB_QUOTA_BYTES - used), source: 'probe', used }
  } else {
    refreshQuotaCache()
  }
  return { remaining: DEFAULT_REMAINING_FALLBACK, source: 'default', used: null }
}

export function getStorageShiftStatus() {
  const books = remainingFor('books')
  const notes = remainingFor('notes')
  const booksRemaining = books.remaining
  const notesRemaining = notes.remaining

  const booksUnder10MB = booksRemaining < TIDB_LOW_STORAGE_THRESHOLD_BYTES
  const notesUnder10MB = notesRemaining < TIDB_LOW_STORAGE_THRESHOLD_BYTES

  const booksUnder1MB = booksRemaining < TIDB_CRITICAL_STORAGE_THRESHOLD_BYTES
  const notesUnder1MB = notesRemaining < TIDB_CRITICAL_STORAGE_THRESHOLD_BYTES
  const isCritical1MB = booksUnder1MB || notesUnder1MB

  return {
    thresholdBytes: TIDB_LOW_STORAGE_THRESHOLD_BYTES,
    thresholdFormatted: '10.00 MB',
    criticalThresholdBytes: TIDB_CRITICAL_STORAGE_THRESHOLD_BYTES,
    criticalThresholdFormatted: '1.00 MB',
    isCritical1MB,
    criticalAlertMessage: isCritical1MB
      ? 'CRITICAL PEAK STORAGE: TiDB has less than 1MB storage remaining. All writes are emergency-diverted to CockroachDB backup storage.'
      : null,
    books: {
      remainingBytes: booksRemaining,
      isUnder10MB: booksUnder10MB,
      isUnder1MB: booksUnder1MB,
      shiftedToTurso: booksUnder10MB,
      quotaSource: books.source,
      usedBytes: books.used,
      quotaBytes: TIDB_QUOTA_BYTES,
      targetEngine: booksUnder1MB
        ? 'CockroachDB (Emergency 1MB Shift)'
        : booksUnder10MB
          ? 'CockroachDB (Shift Active)'
          : 'TiDB Cluster A (Primary)',
    },
    notes: {
      remainingBytes: notesRemaining,
      isUnder10MB: notesUnder10MB,
      isUnder1MB: notesUnder1MB,
      shiftedToTurso: notesUnder10MB,
      quotaSource: notes.source,
      usedBytes: notes.used,
      quotaBytes: TIDB_QUOTA_BYTES,
      targetEngine: notesUnder1MB
        ? 'CockroachDB (Emergency 1MB Shift)'
        : notesUnder10MB
          ? 'CockroachDB (Shift Active)'
          : 'TiDB Cluster B (Primary)',
    },
  }
}

export function shouldShiftToTurso(domain: 'books' | 'notes'): boolean {
  return remainingFor(domain).remaining < TIDB_LOW_STORAGE_THRESHOLD_BYTES
}

export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function isNotFoundError(err: any): boolean {
  if (!err) return false
  if (err instanceof NotFoundError) return true
  const msg = String(err?.message || err || '').toLowerCase()
  return msg.includes('not found') || msg.includes('no book found') || msg.includes('no rows')
}

/**
 * Errors that must NEVER trigger a cross-engine failover (would fork data).
 * Unique-constraint / validation errors mean the write was rejected, not that
 * the cluster is down. Failing over to CockroachDB here creates split-brain duplicates (M-5).
 */
export function isNonFailoverError(err: any): boolean {
  const msg = String(err?.message || err || '')
  const code = String((err as any)?.code || '')
  return (
    code === 'P2002' ||
    /unique constraint|unique.*violation|nothing to update|flyleaf|cannot be removed|refusing auto-sweep|too fresh to sweep|in the trash|trash first|invalid body|required|too many|unauthorized|forbidden|confirm/i.test(
      msg
    )
  )
}

/**
 * Resilient Dynamic Shift Executor:
 * 1. If TiDB cluster is under 10MB remaining storage (or shifted), writes directly to CockroachDB.
 * 2. If TiDB cluster is above 10MB, writes to TiDB; if TiDB fails with a
 *    *connection/storage* error, transparently falls back to CockroachDB.
 *    Validation / constraint / not-found-class errors never fork (M-5) — except
 *    NotFound, which still probes the other engine because shifted rows live
 *    in exactly one store (H-5).
 */
export async function withStorageShift<T>(
  primaryFn: () => Promise<T>,
  fallbackFn: () => Promise<T>,
  domain: 'books' | 'notes',
  operationName: string
): Promise<T> {
  const isShifted = shouldShiftToTurso(domain)
  if (isShifted) {
    console.info(
      `[Storage Shift Active] TiDB ${domain} cluster is under 10MB threshold. Shifting operation "${operationName}" directly to CockroachDB...`
    )
    if (!isTursoConfigured()) {
      console.warn(`[Storage Shift] Backup engine is not configured; attempting TiDB anyway...`)
      return await primaryFn()
    }
    return await fallbackFn()
  }

  // Normal primary path with automatic fallback
  try {
    return await primaryFn()
  } catch (err: any) {
    if (isNonFailoverError(err)) throw err
    if (!isTursoConfigured()) {
      throw err
    }
    // NotFound still probes the other engine (shifted rows live in one store),
    // but the route maps double-miss to 404 (M-7) instead of 500.
    if (!isNotFoundError(err)) {
      console.warn(
        `[TiDB Failover] TiDB operation "${operationName}" failed (${err?.message || err}). Shifting to CockroachDB...`
      )
    }
    try {
      return await fallbackFn()
    } catch (tursoErr: any) {
      // If both engines miss, surface the backup not-found so routes can 404.
      if (isNotFoundError(err) && isNotFoundError(tursoErr)) throw tursoErr
      console.error(`[TiDB Failover] CockroachDB fallback ALSO failed for "${operationName}":`, tursoErr)
      throw tursoErr
    }
  }
}

/**
 * Legacy compatibility wrapper that forwards to withStorageShift or standard fallback.
 */
export async function withTiDBFallback<T>(
  primaryFn: () => Promise<T>,
  fallbackFn: () => Promise<T>,
  operationName: string,
  domain: 'books' | 'notes' = 'books'
): Promise<T> {
  return withStorageShift(primaryFn, fallbackFn, domain, operationName)
}

// --------------------------------------------------------------------------
// Merged Reading Utilities (TiDB + CockroachDB Shifted Content)
// --------------------------------------------------------------------------

/**
 * Merges book pages from TiDB with any pages created in CockroachDB during shifted mode.
 * Resolves duplicate pageNumbers by keeping the most recently updated row (M-1).
 */
export async function getMergedBookPages(
  primaryPages: any[],
  bookId: string
): Promise<any[]> {
  if (!isTursoConfigured()) return primaryPages
  try {
    const tursoPages = await tursoListPages(bookId)
    const existingIds = new Set(primaryPages.map((p) => p.id))
    const shiftedPages = tursoPages.filter((p) => !existingIds.has(p.id))

    if (shiftedPages.length === 0) return primaryPages

    const byNumber = new Map<number, any>()
    for (const p of [...primaryPages, ...shiftedPages]) {
      const cur = byNumber.get(p.pageNumber)
      if (!cur) {
        byNumber.set(p.pageNumber, p)
        continue
      }
      const curT = new Date(cur.updatedAt || cur.createdAt || 0).getTime()
      const nextT = new Date(p.updatedAt || p.createdAt || 0).getTime()
      if (nextT > curT) {
        console.warn(
          `[MergedRead] duplicate pageNumber ${p.pageNumber} for book ${bookId}: keeping newer ${p.id} over ${cur.id}`
        )
        byNumber.set(p.pageNumber, p)
      } else {
        console.warn(
          `[MergedRead] duplicate pageNumber ${p.pageNumber} for book ${bookId}: keeping ${cur.id} over ${p.id}`
        )
      }
    }
    return [...byNumber.values()].sort((a, b) => a.pageNumber - b.pageNumber)
  } catch (e) {
    console.warn('[MergedRead] Failed to query CockroachDB pages for merge:', e)
    return primaryPages
  }
}

/**
  * Merges board notes from TiDB with any board notes created in CockroachDB during shifted mode.
 * Preserves the canonical z-stack order (z ASC, createdAt ASC) — M-1 fix.
 */
export async function getMergedBoardNotes(
  primaryNotes: any[],
  trash = false
): Promise<any[]> {
  if (!isTursoConfigured()) return primaryNotes
  try {
    const res = await tursoGetBoardNotes(trash)
    const existingIds = new Set(primaryNotes.map((n) => n.id))
    const shiftedNotes = (res.notes || []).filter((n) => !existingIds.has(n.id))

    if (shiftedNotes.length === 0) return primaryNotes

    return [...primaryNotes, ...shiftedNotes].sort((a, b) => {
      if (a.z !== b.z) return a.z - b.z
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  } catch (e) {
    console.warn('[MergedRead] Failed to query CockroachDB board notes for merge:', e)
    return primaryNotes
  }
}

/**
 * Merges margin notes for a whole book (H-5: GET /api/notes previously ignored
 * backup-shifted rows, making them look deleted).
 */
export async function getMergedBookPageNotes(
  primaryNotes: any[],
  bookId: string,
  trash = false
): Promise<any[]> {
  if (!isTursoConfigured()) return primaryNotes
  try {
    const res = await tursoGetBookNotes(bookId, trash)
    const existingIds = new Set(primaryNotes.map((n) => n.id))
    const shifted = (res.notes || []).filter((n) => !existingIds.has(n.id))
    if (shifted.length === 0) return primaryNotes
    return [...primaryNotes, ...shifted].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
  } catch (e) {
    console.warn('[MergedRead] Failed to query CockroachDB book notes for merge:', e)
    return primaryNotes
  }
}

/**
 * Merges page margin notes from TiDB with any margin notes created in CockroachDB during shifted mode.
 */
export async function getMergedPageNotes(
  primaryNotes: any[],
  pageId: string
): Promise<any[]> {
  if (!isTursoConfigured()) return primaryNotes
  try {
    const res = await tursoGetPageNotes(pageId)
    const existingIds = new Set(primaryNotes.map((n) => n.id))
    const shiftedNotes = (res.notes || []).filter((n) => !existingIds.has(n.id))

    if (shiftedNotes.length === 0) return primaryNotes

    return [...primaryNotes, ...shiftedNotes].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    )
  } catch (e) {
    console.warn('[MergedRead] Failed to query CockroachDB page notes for merge:', e)
    return primaryNotes
  }
}

// --------------------------------------------------------------------------
// Books & Pages Fallback Operations (CockroachDB backup engine)
// --------------------------------------------------------------------------

/**
 * Reading-position fallback (Wave D): store lastPage on the CockroachDB books row
 * when TiDB Cluster A is unreachable. Clamped to the backup's own max page.
 */
export async function tursoUpdateProgress(page: number): Promise<{ page: number }> {
  await initTursoTables()
  const book = await dbBackup.backupBook.findFirst({ orderBy: { createdAt: 'asc' } })
  if (!book) throw new Error('No book found in CockroachDB backup')
  const maxAgg = await dbBackup.backupPage.aggregate({
    where: { bookId: book.id, pageNumber: { gt: 0 }, deletedAt: null },
    _max: { pageNumber: true },
  })
  const maxPage = Math.max(1, maxAgg._max.pageNumber ?? 1)
  const stored = Math.min(Math.max(1, Math.round(page)), maxPage)
  await dbBackup.backupBook.update({
    where: { id: book.id },
    data: { lastPage: stored, updatedAt: new Date() },
  })
  return { page: stored }
}

export async function tursoGetFirstBookId(): Promise<string | null> {
  const book = await dbBackup.backupBook.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  return book?.id ?? null
}

export async function tursoGetBookWithPages(): Promise<{ book: any; pages: any[] }> {
  await initTursoTables()
  let book = await dbBackup.backupBook.findFirst({ orderBy: { createdAt: 'asc' } })

  if (!book) {
    // Seed default book in the backup engine if empty
    const now = new Date()
    book = await dbBackup.backupBook.create({
      data: {
        id: 'default-book',
        title: 'Libris',
        subtitle: 'Notes in the Margin',
        author: '',
        description: 'A personal reading journal and thought collection.',
        coverTheme: 'emerald',
        lastPage: 1,
        createdAt: now,
        updatedAt: now,
      },
    })
  }

  const pages = await dbBackup.backupPage.findMany({
    where: { bookId: book.id, deletedAt: null },
    orderBy: { pageNumber: 'asc' },
  })

  return {
    book: mapBookRow(book),
    pages: pages.map(mapPageRow),
  }
}

export async function tursoListPages(bookId: string): Promise<any[]> {
  const pages = await dbBackup.backupPage.findMany({
    where: { bookId, deletedAt: null },
    orderBy: { pageNumber: 'asc' },
  })
  return pages.map(mapPageRow)
}

export async function tursoCreatePage(
  bookId: string,
  afterPageNumber?: number,
  title = '',
  content = ''
): Promise<{ page: any; pages: any[] }> {
  await initTursoTables()
  const pages = await tursoListPages(bookId)
  const numbered = pages.filter((p) => p.pageNumber > 0)
  const maxPage = numbered.length ? Math.max(...numbered.map((p) => p.pageNumber)) : 0

  const after =
    typeof afterPageNumber === 'number' && Number.isFinite(afterPageNumber)
      ? Math.min(Math.max(0, Math.floor(afterPageNumber)), maxPage)
      : maxPage

  const now = new Date()
  const newPageId = `turso_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

  // Renumber + insert inside one CockroachDB transaction. Live rows shift via
  // the negate trick (tombstones excluded); concurrent inserts serialize on
  // the unique index — a P2002-equivalent aborts the whole tx for retry above.
  await dbBackup.$transaction(async (tx) => {
    if (after < maxPage) {
      await tx.$executeRaw`UPDATE "pages" SET "pageNumber" = -"pageNumber" WHERE "bookId" = ${bookId} AND "pageNumber" > ${after} AND "deletedAt" IS NULL`;
      await tx.$executeRaw`UPDATE "pages" SET "pageNumber" = -"pageNumber" + 1 WHERE "bookId" = ${bookId} AND "pageNumber" < 0 AND "deletedAt" IS NULL`;
    }
    await tx.backupPage.create({
      data: {
        id: newPageId,
        bookId,
        pageNumber: after + 1,
        chapter: 1,
        section: 'Writing',
        title,
        content,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      },
    });
  })

  // Renumber notes on subsequent pages
  if (after < maxPage) {
    try {
      await dbBackup.backupPageNote.updateMany({
        where: { bookId, pageNumber: { gt: after }, deletedAt: null },
        data: { pageNumber: { increment: 1 } },
      })
    } catch (e) {
      console.warn('[turso] notes renumbering after insert warning:', e)
    }
  }

  const updatedPages = await tursoListPages(bookId)
  const createdPage = updatedPages.find((p) => p.id === newPageId) || {
    id: newPageId,
    bookId,
    pageNumber: after + 1,
    chapter: 1,
    section: 'Writing',
    title,
    content,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  }

  return { page: createdPage, pages: updatedPages }
}

export async function tursoUpdatePage(
  pageId: string,
  data: { content?: string; title?: string; pinned?: boolean }
): Promise<{ page: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupPage.findUnique({ where: { id: pageId } })
  if (!existing) {
    throw new Error('Page not found in CockroachDB backup')
  }
  // Tombstoned rows are gone for writers (message keeps 'not found' so the
  // failover classifier still maps double-miss to 404, not 500).
  if (existing.deletedAt) {
    throw new Error('Page not found (deleted)')
  }
  const updated = await dbBackup.backupPage.update({
    where: { id: pageId },
    data: {
      content: typeof data.content === 'string' ? data.content : undefined,
      title: typeof data.title === 'string' ? data.title : undefined,
      pinned: typeof data.pinned === 'boolean' ? data.pinned : undefined,
      updatedAt: new Date(),
    },
  })

  return { page: mapPageRow(updated) }
}

export async function tursoDeletePage(
  pageId: string,
  opts?: { sweep?: boolean }
): Promise<{ pages: any[] }> {
  await initTursoTables()
  const existing = await dbBackup.backupPage.findUnique({ where: { id: pageId } })
  if (!existing) {
    throw new Error('Page not found in CockroachDB backup')
  }
  if (existing.deletedAt) {
    throw new Error('Page not found (deleted)')
  }
  if (existing.pageNumber === 0) {
    throw new Error('The flyleaf cannot be removed')
  }
  if (
    opts?.sweep &&
    (existing.pinned ||
      !isBlankHtml(existing.content) ||
      (existing.title ?? '').trim().length !== 0)
  ) {
    throw new Error('Page is not blank — refusing auto-sweep')
  }
  if (opts?.sweep && Date.now() - existing.createdAt.getTime() < SWEEP_MIN_AGE_MS) {
    throw new Error('Page is too fresh to sweep — try again later')
  }

  // Soft delete: tombstone parks below any existing negative (unique across
  // delete → recreate → delete cycles), freeing its live slot; live rows
  // above then close the gap. Tombstones never renumber.
  const nowDel = new Date()
  const minAgg = await dbBackup.backupPage.aggregate({
    where: { bookId: existing.bookId, pageNumber: { lt: 0 } },
    _min: { pageNumber: true },
  })
  const tombNumber = Math.min(-existing.pageNumber, (minAgg._min.pageNumber ?? 0) - 1)
  await dbBackup.$transaction(async (tx) => {
    await tx.backupPage.update({
      where: { id: pageId },
      data: { deletedAt: nowDel, pageNumber: tombNumber },
    })
    if (existing.pageNumber > 0) {
      await tx.$executeRaw`UPDATE "pages" SET "pageNumber" = "pageNumber" - 1 WHERE "bookId" = ${existing.bookId} AND "pageNumber" > ${existing.pageNumber} AND "deletedAt" IS NULL`;
    }
  })

  // Sync page notes
  try {
    const nowIso = new Date()
    await dbBackup.backupPageNote.updateMany({
      where: { bookId: existing.bookId, pageId, deletedAt: null },
      data: { deletedAt: nowIso, updatedAt: nowIso },
    })
    if (existing.pageNumber > 0) {
      await dbBackup.backupPageNote.updateMany({
        where: { bookId: existing.bookId, pageNumber: { gt: existing.pageNumber }, deletedAt: null },
        data: { pageNumber: { decrement: 1 } },
      })
    }
  } catch (e) {
    console.warn('[turso] notes sync after delete warning:', e)
  }

  const pages = await tursoListPages(existing.bookId)
  return { pages }
}

// --------------------------------------------------------------------------
// Board Notes Fallback Operations (CockroachDB backup engine)
// --------------------------------------------------------------------------

export async function tursoGetBoardNotes(trash = false): Promise<{ notes: any[] }> {
  await initTursoTables()
  const notes = await dbBackup.backupBoardNote.findMany({
    where: trash ? { deletedAt: { not: null } } : { deletedAt: null },
    orderBy: [{ z: 'asc' }, { createdAt: 'asc' }],
  })
  return { notes: notes.map(mapBoardNoteRow) }
}

export async function tursoCreateBoardNote(data: {
  content?: string
  color?: string
  type?: string
  x?: number
  y?: number
  width?: number
  height?: number
  rotation?: number
}): Promise<{ note: any }> {
  await initTursoTables()
  const id = `turso_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const now = new Date()

  const content = typeof data.content === 'string' ? data.content.slice(0, 20000) : ''
  const color = data.color || 'amber'
  const type = data.type || 'sticky'
  // Same bounds as the TiDB route (Wave D) so shifted notes can't land
  // off-canvas or gigantic.
  const clampN = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v)))
  const numOr = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const x = clampN(numOr(data.x, 120), 0, 4000)
  const y = clampN(numOr(data.y, 120), 0, 4000)
  const width = clampN(numOr(data.width, type === 'card' ? 280 : 220), 140, 1600)
  const height = clampN(numOr(data.height, type === 'card' ? 200 : 220), 140, 1600)
  const rotation = clampN(numOr(data.rotation, 0), -30, 30)

  // z allocation serialized in a transaction (Wave D intent, CockroachDB
  // form): MAX(z)+1 read and insert commit atomically.
  const note = await dbBackup.$transaction(async (tx) => {
    const top = await tx.$queryRaw<Array<{ m: number | null }>>`
      SELECT COALESCE(MAX(z), 0) AS m FROM "board_notes" FOR UPDATE
    `
    const z = Number((top?.[0] as any)?.m ?? 0) + 1
    return await tx.backupBoardNote.create({
      data: {
        id,
        content,
        color,
        type,
        x,
        y,
        width,
        height,
        rotation,
        z,
        pinned: false,
        createdAt: now,
        updatedAt: now,
      },
    })
  })

  return { note: mapBoardNoteRow(note) }
}

export async function tursoUpdateBoardNote(
  noteId: string,
  data: Record<string, any>
): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupBoardNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Board note not found in CockroachDB backup')
  if (existing.deletedAt) throw new Error('This note is in the trash')

  // Same bounds as the TiDB route (Wave D).
  const clampT = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v)))
  const patch: Record<string, any> = { updatedAt: new Date() }
  if (typeof data.content === 'string') patch.content = data.content.slice(0, 20000)
  if (typeof data.color === 'string') patch.color = data.color
  if (typeof data.type === 'string') patch.type = data.type
  if (typeof data.pinned === 'boolean') patch.pinned = data.pinned
  if (typeof data.x === 'number') patch.x = clampT(data.x, 0, 4000)
  if (typeof data.y === 'number') patch.y = clampT(data.y, 0, 4000)
  if (typeof data.width === 'number') patch.width = clampT(data.width, 140, 1600)
  if (typeof data.height === 'number') patch.height = clampT(data.height, 140, 1600)
  if (typeof data.rotation === 'number') patch.rotation = clampT(data.rotation, -30, 30)
  if (typeof data.z === 'number') patch.z = clampT(data.z, 0, 10000)

  const note = await dbBackup.backupBoardNote.update({ where: { id: noteId }, data: patch })
  return { note: mapBoardNoteRow(note) }
}

export async function tursoDeleteBoardNote(noteId: string): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupBoardNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Board note not found')
  if (existing.deletedAt) return { note: mapBoardNoteRow(existing) }

  const now = new Date()
  const note = await dbBackup.backupBoardNote.update({
    where: { id: noteId },
    data: { deletedAt: now, updatedAt: now },
  })

  return { note: mapBoardNoteRow(note) }
}

export async function tursoRestoreBoardNote(noteId: string): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupBoardNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Board note not found')

  const now = new Date()
  const note = await dbBackup.backupBoardNote.update({
    where: { id: noteId },
    data: { deletedAt: null, updatedAt: now },
  })

  return { note: mapBoardNoteRow(note) }
}


// --------------------------------------------------------------------------
// Page Notes Fallback Operations (CockroachDB backup engine)
// --------------------------------------------------------------------------

export async function tursoGetPageNotes(pageId: string): Promise<{ page: any; notes: any[] }> {
  await initTursoTables()
  const page = await dbBackup.backupPage.findUnique({ where: { id: pageId } })
  if (!page) throw new Error('Page not found')
  if (page.deletedAt) throw new Error('Page not found (deleted)')

  const notes = await dbBackup.backupPageNote.findMany({
    where: { pageId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })

  return { page: mapPageRow(page), notes: notes.map(mapPageNoteRow) }
}

export async function tursoGetBookNotes(bookId: string, trash = false): Promise<{ notes: any[] }> {
  await initTursoTables()
  const notes = await dbBackup.backupPageNote.findMany({
    where: trash ? { bookId, deletedAt: { not: null } } : { bookId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  return { notes: notes.map(mapPageNoteRow) }
}

export async function tursoCreatePageNote(data: {
  pageId: string
  content: string
  color?: string
}): Promise<{ note: any }> {
  await initTursoTables()
  const page = await dbBackup.backupPage.findUnique({ where: { id: data.pageId } })
  if (!page) throw new Error('Page not found')
  if (page.deletedAt) throw new Error('Page not found (deleted)')

  const id = `turso_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const now = new Date()
  const color = data.color || 'amber'

  const note = await dbBackup.backupPageNote.create({
    data: {
      id,
      bookId: page.bookId,
      pageId: page.id,
      pageNumber: page.pageNumber,
      content: data.content,
      color,
      createdAt: now,
      updatedAt: now,
    },
  })

  return { note: mapPageNoteRow(note) }
}

export async function tursoUpdatePageNote(
  noteId: string,
  data: { content?: string; color?: string }
): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupPageNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Note not found')
  if (existing.deletedAt) throw new Error('This note is in the trash')

  const note = await dbBackup.backupPageNote.update({
    where: { id: noteId },
    data: {
      content: typeof data.content === 'string' ? data.content.slice(0, 20000) : undefined,
      color: typeof data.color === 'string' ? data.color : undefined,
      updatedAt: new Date(),
    },
  })

  return { note: mapPageNoteRow(note) }
}

export async function tursoDeletePageNote(noteId: string): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupPageNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Note not found')
  if (existing.deletedAt) return { note: mapPageNoteRow(existing) }

  const now = new Date()
  const note = await dbBackup.backupPageNote.update({
    where: { id: noteId },
    data: { deletedAt: now, updatedAt: now },
  })

  return { note: mapPageNoteRow(note) }
}

export async function tursoRestorePageNote(noteId: string): Promise<{ note: any }> {
  await initTursoTables()
  const existing = await dbBackup.backupPageNote.findUnique({ where: { id: noteId } })
  if (!existing) throw new Error('Note not found')

  const note = await dbBackup.backupPageNote.update({
    where: { id: noteId },
    data: { deletedAt: null, updatedAt: new Date() },
  })

  return { note: mapPageNoteRow(note) }
}

export async function tursoSearchNotes(query: string): Promise<{ notes: any[] }> {
  await initTursoTables()
  // Escape LIKE wildcards so q=%% can't dump the table. CockroachDB/Postgres
  // treats backslash as the default LIKE escape, same as MySQL here.
  // (Prisma `contains` adds its own %…% wrapping — pass the bare pattern.)
  const found = await dbBackup.backupPageNote.findMany({
    where: { content: { contains: escapeLikeWildcards(String(query)) }, deletedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 30,
  })

  if (found.length === 0) return { notes: [] }
  const notes = found.map(mapPageNoteRow)

  const pageIds = [...new Set(notes.map((n) => n.pageId))]
  const backupPages = await dbBackup.backupPage.findMany({
    where: { id: { in: pageIds } },
    select: { id: true, title: true, section: true },
  })
  const pageMap = new Map<string, { title: string; section: string }>()
  for (const row of backupPages) {
    pageMap.set(String(row.id), {
      title: String(row.title),
      section: String(row.section),
    })
  }

  return {
    notes: notes.map((n) => ({
      ...n,
      pageTitle: pageMap.get(n.pageId)?.title || 'Unknown page',
      section: pageMap.get(n.pageId)?.section || '',
    })),
  }
}


