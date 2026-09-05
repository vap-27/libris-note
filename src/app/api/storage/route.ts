import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import { dbBackup } from '@/lib/db-backup'
import {
  isTursoConfigured,
  initTursoTables,
  getStorageShiftStatus,
  flushReplicationQueue,
  getReplicationStats,
  buildDivergence,
  backupAllToTurso,
  getBackupDiskUsage,
  getBackupQuotaBytes,
} from '@/lib/turso'
import { getUsrinfoStats, getUsrinfoQuotaBytes } from '@/lib/usrinfo'
import { requireAdmin, requireAdminForDestructive } from '@/lib/auth'
import { rlRead, rlDestructive } from '@/lib/rate-limit'
import { logActivity } from '@/lib/logger'
import { sanitizeLogText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  // Binary units throughout the codebase — label honestly as GiB.
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

// 30s telemetry cache (M-3): /storage polls full tables otherwise.
let cache: { at: number; body: unknown } | null = null
const CACHE_MS = 30_000

/**
 * GET /api/storage
 * Storage telemetry. Uses COUNT + SUM(LENGTH) aggregates (no unbounded findMany),
 * redacts real endpoints (L-5), caches 30s, gated when ADMIN_TOKEN is set.
 */
export async function GET(req: NextRequest) {
  const limited = await rlRead(req, 'storage')
  if (limited) return limited
  const gate = requireAdmin(req)
  if (gate) return gate

  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.body)
  }

  const t0 = Date.now()

  // 1. TiDB Books Cluster Telemetry (aggregates only).
  // HONESTY: LENGTH() measures bytes (CHAR_LENGTH undercounts multibyte
  // text — proven live: 2185 chars vs 2205 bytes). All text columns are
  // summed; scalars get a per-row allowance; +32 KiB covers table overhead.
  // This is still an ESTIMATE (indexes/billed logical size invisible from
  // SQL on Serverless) — hence bytesMeasured:false + method below.
  let tidbBooksOk = false
  let tidbBooksLatency = 0
  let tidbBooksCount = 0
  let tidbPagesCount = 0
  let tidbPagesLiveCount = 0
  let tidbPagesTombstonedCount = 0
  let tidbBooksBytes = 0

  const startBooks = Date.now()
  try {
    const [booksCount, pagesCount, pagesLiveCount] = await Promise.all([
      dbBooks.book.count(),
      dbBooks.page.count(),
      dbBooks.page.count({ where: { deletedAt: null } }),
    ])
    // Bounded byte estimate via SQL SUM(LENGTH) — no full-table load.
    let bytes = 32 * 1024
    try {
      const rows = await dbBooks.$queryRaw<Array<{ b: bigint | number | null; p: bigint | number | null }>>`
        SELECT
          (SELECT COALESCE(SUM(LENGTH(title) + LENGTH(COALESCE(subtitle,'')) + LENGTH(author) + LENGTH(COALESCE(description,'')) + LENGTH(coverTheme) + 256), 0) FROM Book) AS b,
          (SELECT COALESCE(SUM(LENGTH(title) + LENGTH(content) + LENGTH(section) + 512), 0) FROM Page) AS p
      `
      const r = rows?.[0] as any
      bytes += Number(r?.b ?? 0) + Number(r?.p ?? 0)
    } catch {
      bytes += (booksCount + pagesCount) * 512 + 32 * 1024
    }
    tidbBooksOk = true
    tidbBooksLatency = Date.now() - startBooks
    tidbBooksCount = booksCount
    tidbPagesCount = pagesCount
    tidbPagesLiveCount = pagesLiveCount
    tidbPagesTombstonedCount = pagesCount - pagesLiveCount
    tidbBooksBytes = bytes
  } catch (err) {
    console.warn('[api/storage] TiDB Books cluster error')
  }

  // 2. TiDB Notes Cluster Telemetry (same honesty contract as §1).
  let tidbNotesOk = false
  let tidbNotesLatency = 0
  let tidbPageNotesCount = 0
  let tidbPageNotesLiveCount = 0
  let tidbBoardNotesCount = 0
  let tidbBoardNotesLiveCount = 0
  let tidbNotesBytes = 0

  const startNotes = Date.now()
  try {
    const [pageNotesCount, boardNotesCount, pageNotesLiveCount, boardNotesLiveCount] = await Promise.all([
      dbNotes.pageNote.count(),
      dbNotes.boardNote.count(),
      dbNotes.pageNote.count({ where: { deletedAt: null } }),
      dbNotes.boardNote.count({ where: { deletedAt: null } }),
    ])
    let bytes = 32 * 1024
    try {
      const rows = await dbNotes.$queryRaw<Array<{ a: bigint | number | null; b: bigint | number | null }>>`
        SELECT
          (SELECT COALESCE(SUM(LENGTH(content) + 256), 0) FROM PageNote) AS a,
          (SELECT COALESCE(SUM(LENGTH(content) + 384), 0) FROM BoardNote) AS b
      `
      const r = rows?.[0] as any
      bytes += Number(r?.a ?? 0) + Number(r?.b ?? 0)
    } catch {
      bytes += (pageNotesCount + boardNotesCount) * 384 + 32 * 1024
    }
    tidbNotesOk = true
    tidbNotesLatency = Date.now() - startNotes
    tidbPageNotesCount = pageNotesCount
    tidbBoardNotesCount = boardNotesCount
    tidbPageNotesLiveCount = pageNotesLiveCount
    tidbBoardNotesLiveCount = boardNotesLiveCount
    tidbNotesBytes = bytes
  } catch (err) {
    console.warn('[api/storage] TiDB Notes cluster error')
  }

  // 3. CockroachDB backup telemetry — REAL measurements only.
  // Row counts via COUNT(*); bytes via octet_length content sums (actual
  // stored bytes measured in SQL). No count*1024 estimates anywhere here.
  let tursoOk = false
  let tursoLatency = 0
  let tursoBooksCount = 0
  let tursoPagesCount = 0
  let tursoPagesLiveCount = 0
  let tursoPageNotesCount = 0
  let tursoPageNotesLiveCount = 0
  let tursoBoardNotesCount = 0
  let tursoBoardNotesLiveCount = 0
  let tursoLastBackupAt: string | null = null
  let tursoBytes = 0
  let tursoBytesMeasured = false

  if (isTursoConfigured()) {
    const startTurso = Date.now()
    try {
      await initTursoTables()
      const [booksCount, pagesCount, pagesLiveCount, pageNotesCount, pageNotesLiveCount, boardNotesCount, boardNotesLiveCount, meta, disk] = await Promise.all([
        dbBackup.backupBook.count(),
        dbBackup.backupPage.count(),
        dbBackup.backupPage.count({ where: { deletedAt: null } }),
        dbBackup.backupPageNote.count(),
        dbBackup.backupPageNote.count({ where: { deletedAt: null } }),
        dbBackup.backupBoardNote.count(),
        dbBackup.backupBoardNote.count({ where: { deletedAt: null } }),
        dbBackup.backupMeta.findUnique({ where: { key: 'last_backup_at' } }),
        getBackupDiskUsage(),
      ])

      tursoOk = true
      tursoLatency = Date.now() - startTurso
      tursoBooksCount = booksCount
      tursoPagesCount = pagesCount
      tursoPagesLiveCount = pagesLiveCount
      tursoPageNotesCount = pageNotesCount
      tursoPageNotesLiveCount = pageNotesLiveCount
      tursoBoardNotesCount = boardNotesCount
      tursoBoardNotesLiveCount = boardNotesLiveCount
      tursoLastBackupAt = meta?.value ?? null
      if (disk.ok) {
        tursoBytes = disk.totalBytes
        tursoBytesMeasured = true
      }
    } catch (err) {
      console.warn('[api/storage] CockroachDB telemetry error')
    }
  }

  // 3b. Users store telemetry (third TiDB cluster: identities + presence + leases).
  // Real COUNT(*) rows + measured content bytes; the ceiling is the
  // documented TiDB Starter allowance (labeled with its source).
  let usrinfoOk = false
  let usrinfoStatus: 'online' | 'offline' | 'not_configured' = 'not_configured'
  let usrinfoLatency = 0
  let usrinfoIdentities = 0
  let usrinfoPresenceRows = 0
  let usrinfoLiveLocks = 0
  let usrinfoBytes = 0
  let usrinfoBytesMeasured = false
  try {
    const u = await getUsrinfoStats()
    usrinfoOk = u.ok
    usrinfoStatus = u.status
    usrinfoLatency = u.latencyMs
    usrinfoIdentities = u.identities
    usrinfoPresenceRows = u.presenceRows
    usrinfoLiveLocks = u.liveLocks
    usrinfoBytes = u.contentBytes
    usrinfoBytesMeasured = u.bytesMeasured
  } catch {
    // getUsrinfoStats never throws; defensive only.
  }
  const USRINFO_QUOTA_BYTES = getUsrinfoQuotaBytes()
  const usrinfoQuotaSource = process.env.USERS_QUOTA_BYTES
    ? ('env-override' as const)
    : ('tidb-starter-5gib-row-default' as const)

  // 4. Quotas & Aggregations — every ceiling labeled with its source.
  const TIDB_CLUSTER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB
  const BACKUP_QUOTA_BYTES = getBackupQuotaBytes()
  const backupQuotaSource = process.env.BACKUP_QUOTA_BYTES
    ? ('env-override' as const)
    : ('cockroachdb-cloud-basic-10gib-default' as const)

  const TOTAL_INFRASTRUCTURE_QUOTA_BYTES = TIDB_CLUSTER_QUOTA_BYTES * 2 + BACKUP_QUOTA_BYTES
  const totalUsedBytes = tidbBooksBytes + tidbNotesBytes + tursoBytes
  const totalAvailableBytes = Math.max(0, TOTAL_INFRASTRUCTURE_QUOTA_BYTES - totalUsedBytes)
  const totalPercentUsed = Number(((totalUsedBytes / TOTAL_INFRASTRUCTURE_QUOTA_BYTES) * 100).toFixed(4))

  const body = {
    timestamp: new Date().toISOString(),
    queryDurationMs: Date.now() - t0,
    overall: {
      status: tidbBooksOk && tidbNotesOk ? 'healthy' : tursoOk ? 'failover_active' : 'degraded',
      failoverMode: tidbBooksOk && tidbNotesOk ? 'standby' : 'active',
      totalQuotaBytes: TOTAL_INFRASTRUCTURE_QUOTA_BYTES,
      totalQuotaFormatted: formatBytes(TOTAL_INFRASTRUCTURE_QUOTA_BYTES),
      // UsrInfo's Turso side-quota is tracked separately (see `usrinfo`
      // block) and intentionally excluded from this total.
      quotaNote: 'TiDB ×3 (books, notes, users) + CockroachDB; users-cluster quota tracked in `usrinfo` block',
      totalUsedBytes,
      totalUsedFormatted: formatBytes(totalUsedBytes),
      totalAvailableBytes,
      totalAvailableFormatted: formatBytes(totalAvailableBytes),
      percentUsed: totalPercentUsed,
    },
    tidb: {
      booksCluster: {
        label: 'TiDB Cluster A (Books Database)',
        status: tidbBooksOk ? 'online' : 'offline',
        latencyMs: tidbBooksLatency,
        quotaBytes: TIDB_CLUSTER_QUOTA_BYTES,
        quotaFormatted: formatBytes(TIDB_CLUSTER_QUOTA_BYTES),
        quotaSource: 'tidb-starter-5gib-row-default',
        usedBytes: tidbBooksBytes,
        usedFormatted: formatBytes(tidbBooksBytes),
        // TiDB Serverless exposes no billed-size SQL probe: this is a
        // LENGTH()+allowance estimate, flagged so the UI never claims more.
        bytesMeasured: false,
        method: 'length-sum-estimate',
        availableBytes: Math.max(0, TIDB_CLUSTER_QUOTA_BYTES - tidbBooksBytes),
        availableFormatted: formatBytes(Math.max(0, TIDB_CLUSTER_QUOTA_BYTES - tidbBooksBytes)),
        percentUsed: Number(((tidbBooksBytes / TIDB_CLUSTER_QUOTA_BYTES) * 100).toFixed(4)),
        tables: {
          books: tidbBooksCount,
          pages: tidbPagesCount,
          pagesLive: tidbPagesLiveCount,
          pagesTombstoned: tidbPagesTombstonedCount,
        },
      },
      notesCluster: {
        label: 'TiDB Cluster B (Notes Database)',
        status: tidbNotesOk ? 'online' : 'offline',
        latencyMs: tidbNotesLatency,
        quotaBytes: TIDB_CLUSTER_QUOTA_BYTES,
        quotaFormatted: formatBytes(TIDB_CLUSTER_QUOTA_BYTES),
        quotaSource: 'tidb-starter-5gib-row-default',
        usedBytes: tidbNotesBytes,
        usedFormatted: formatBytes(tidbNotesBytes),
        bytesMeasured: false,
        method: 'length-sum-estimate',
        availableBytes: Math.max(0, TIDB_CLUSTER_QUOTA_BYTES - tidbNotesBytes),
        availableFormatted: formatBytes(Math.max(0, TIDB_CLUSTER_QUOTA_BYTES - tidbNotesBytes)),
        percentUsed: Number(((tidbNotesBytes / TIDB_CLUSTER_QUOTA_BYTES) * 100).toFixed(4)),
        tables: {
          pageNotes: tidbPageNotesCount,
          pageNotesLive: tidbPageNotesLiveCount,
          pageNotesTombstoned: tidbPageNotesCount - tidbPageNotesLiveCount,
          boardNotes: tidbBoardNotesCount,
          boardNotesLive: tidbBoardNotesLiveCount,
          boardNotesTombstoned: tidbBoardNotesCount - tidbBoardNotesLiveCount,
        },
      },
    },
    turso: {
      label: 'CockroachDB Backup Engine',
      status: tursoOk ? 'online' : 'offline',
      latencyMs: tursoLatency,
      quotaBytes: BACKUP_QUOTA_BYTES,
      quotaFormatted: formatBytes(BACKUP_QUOTA_BYTES),
      // Honest ceiling: plan default unless the operator overrode it.
      quotaSource: backupQuotaSource,
      // Honest usage: measured on disk, or explicitly unmeasured.
      usedBytes: tursoBytes,
      usedFormatted: tursoBytesMeasured ? formatBytes(tursoBytes) : 'unmeasured',
      bytesMeasured: tursoBytesMeasured,
      availableBytes: Math.max(0, BACKUP_QUOTA_BYTES - tursoBytes),
      availableFormatted: tursoBytesMeasured
        ? formatBytes(Math.max(0, BACKUP_QUOTA_BYTES - tursoBytes))
        : 'unmeasured',
      percentUsed: tursoBytesMeasured
        ? Number(((tursoBytes / BACKUP_QUOTA_BYTES) * 100).toFixed(4))
        : 0,
      lastBackupAt: tursoLastBackupAt,
      tables: {
        books: tursoBooksCount,
        pages: tursoPagesCount,
        pagesLive: tursoPagesLiveCount,
        pagesTombstoned: tursoPagesCount - tursoPagesLiveCount,
        pageNotes: tursoPageNotesCount,
        pageNotesLive: tursoPageNotesLiveCount,
        pageNotesTombstoned: tursoPageNotesCount - tursoPageNotesLiveCount,
        boardNotes: tursoBoardNotesCount,
        boardNotesLive: tursoBoardNotesLiveCount,
        boardNotesTombstoned: tursoBoardNotesCount - tursoBoardNotesLiveCount,
      },
    },
    usrinfo: {
      label: 'Users Store (TiDB users_db) — identities, presence, page leases',
      status: usrinfoStatus,
      latencyMs: usrinfoLatency,
      quotaBytes: USRINFO_QUOTA_BYTES,
      quotaFormatted: formatBytes(USRINFO_QUOTA_BYTES),
      quotaSource: usrinfoQuotaSource,
      usedBytes: usrinfoBytes,
      usedFormatted: usrinfoBytesMeasured ? formatBytes(usrinfoBytes) : 'unmeasured',
      bytesMeasured: usrinfoBytesMeasured,
      availableBytes: Math.max(0, USRINFO_QUOTA_BYTES - usrinfoBytes),
      availableFormatted: usrinfoBytesMeasured
        ? formatBytes(Math.max(0, USRINFO_QUOTA_BYTES - usrinfoBytes))
        : 'unmeasured',
      percentUsed: usrinfoBytesMeasured
        ? Number(((usrinfoBytes / USRINFO_QUOTA_BYTES) * 100).toFixed(4))
        : 0,
      tables: {
        identities: usrinfoIdentities,
        presence: usrinfoPresenceRows,
        pageLocks: usrinfoLiveLocks,
      },
    },
    shiftEngine: getStorageShiftStatus(),
    replication: {
      ...getReplicationStats(),
      divergence: buildDivergence(
        {
          books: tidbBooksCount,
          pages: tidbPagesCount,
          pageNotes: tidbPageNotesCount,
          boardNotes: tidbBoardNotesCount,
        },
        {
          books: tursoBooksCount,
          pages: tursoPagesCount,
          pageNotes: tursoPageNotesCount,
          boardNotes: tursoBoardNotesCount,
        }
      ),
      repairHint: 'POST /api/storage {"action":"repair"} runs a full TiDB → CockroachDB snapshot to heal drift.',
    },
  }

  // Opportunistic retry of failed replications (serverless-safe: runs inside
  // this request, fire-and-forget so telemetry stays fast).
  void flushReplicationQueue().catch(() => {})

  cache = { at: Date.now(), body }
  return NextResponse.json(body)
}

/**
 * POST /api/storage  { action: 'repair' }
 * One-click drift repair: full snapshot TiDB → CockroachDB (same engine as /api/backup).
 */
export async function POST(req: NextRequest) {
  try {
    // Rate-limit BEFORE auth (N1): no unthrottled 401 oracle for token probing.
    const limited = await rlDestructive(req, 'storage-repair')
    if (limited) return limited
    const gate = requireAdminForDestructive(req)
    if (gate) return gate
    const body = await req.json().catch(() => ({}))
    // Permanent prune: hard-delete page tombstones older than N days from
    // BOTH engines. Explicit operator action only — never automatic.
    if (body?.action === 'prune') {
      const days = Math.min(3650, Math.max(1, Math.floor(Number(body?.olderThanDays ?? 30))))
      if (!Number.isFinite(days)) {
        return NextResponse.json({ error: 'olderThanDays must be a number' }, { status: 400 })
      }
      const cutoff = new Date(Date.now() - days * 86400000)
      const tidbPruned = await dbBooks.page.deleteMany({ where: { deletedAt: { lt: cutoff } } })
      let tursoPruned = 0
      if (isTursoConfigured()) {
        await initTursoTables()
        const res = await dbBackup.backupPage.deleteMany({
          where: { deletedAt: { not: null, lt: cutoff } },
        })
        tursoPruned = res.count
      }
      // Diagnostic log retention (Wave E): system_logs is append-only with no
      // TTL — prune entries older than 30 days alongside tombstones.
      // Timestamps are ISO strings; lexical comparison is chronological.
      let logsPruned = 0
      if (isTursoConfigured()) {
        try {
          const cutoffLogs = new Date(Date.now() - 30 * 86400000).toISOString()
          const lr = await dbBackup.systemLog.deleteMany({
            where: { timestamp: { lt: cutoffLogs } },
          })
          logsPruned = lr.count
        } catch {
          // Non-fatal: tombstone prune still proceeds.
        }
      }
      cache = null
      logActivity({
        action: 'delete',
        title: 'Tombstones Pruned',
        details: sanitizeLogText(
          `Hard-deleted ${tidbPruned.count} TiDB + ${tursoPruned} CockroachDB tombstoned pages older than ${days}d; ${logsPruned} log rows expired`
        ),
        engine: 'System',
        level: 'warn',
      })
      return NextResponse.json({
        message: `Pruned tombstones older than ${days} days`,
        tidb: tidbPruned.count,
        turso: tursoPruned,
        logsExpired: logsPruned,
      })
    }
    if (body?.action !== 'repair') {
      return NextResponse.json({ error: 'Unknown action (expected {"action":"repair"} or {"action":"prune"})' }, { status: 400 })
    }
    if (!isTursoConfigured()) {
      return NextResponse.json({ error: 'Backup engine is not configured' }, { status: 400 })
    }
    cache = null
    const result = await backupAllToTurso()
    logActivity({
      action: 'sync',
      title: 'Drift Repair Run',
      details: sanitizeLogText(
        `Repair snapshot: ${result.stats.pages} pages, ${result.stats.pageNotes} margin notes, ${result.stats.boardNotes} board notes`
      ),
      engine: 'CockroachDB',
      level: 'success',
    })
    return NextResponse.json({ message: 'Repair snapshot completed', ...result })
  } catch {
    return NextResponse.json({ error: 'Repair failed' }, { status: 500 })
  }
}
