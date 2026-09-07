import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import { dbBackup } from '@/lib/db-backup'
import {
  isBackupConfigured,
  initBackupTables,
  getStorageShiftStatus,
  flushReplicationQueue,
  getReplicationStats,
  buildDivergence,
  snapshotToBackup,
  getBackupDiskUsage,
  getBackupQuotaBytes,
} from '@/lib/backup-engine'
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
  // Binary units throughout the codebase Ã¢â‚¬â€ label honestly as GiB.
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
  // text Ã¢â‚¬â€ proven live: 2185 chars vs 2205 bytes). All text columns are
  // summed; scalars get a per-row allowance; +32 KiB covers table overhead.
  // This is still an ESTIMATE (indexes/billed logical size invisible from
  // SQL on Serverless) Ã¢â‚¬â€ hence bytesMeasured:false + method below.
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
    // Bounded byte estimate via SQL SUM(LENGTH) Ã¢â‚¬â€ no full-table load.
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

  // 2. TiDB Notes Cluster Telemetry (same honesty contract as Ã‚Â§1).
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

  // 3. CockroachDB backup telemetry Ã¢â‚¬â€ REAL measurements only.
  // Row counts via COUNT(*); bytes via octet_length content sums (actual
  // stored bytes measured in SQL). No count*1024 estimates anywhere here.
  let backupOk = false
  let backupLatency = 0
  let backupBooksCount = 0
  let backupPagesCount = 0
  let backupPagesLiveCount = 0
  let backupPageNotesCount = 0
  let backupPageNotesLiveCount = 0
  let backupBoardNotesCount = 0
  let backupBoardNotesLiveCount = 0
  let backupLastBackupAt: string | null = null
  let backupBytes = 0
  let backupBytesMeasured = false

  if (isBackupConfigured()) {
    const startBackup = Date.now()
    try {
      await initBackupTables()
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

      backupOk = true
      backupLatency = Date.now() - startBackup
      backupBooksCount = booksCount
      backupPagesCount = pagesCount
      backupPagesLiveCount = pagesLiveCount
      backupPageNotesCount = pageNotesCount
      backupPageNotesLiveCount = pageNotesLiveCount
      backupBoardNotesCount = boardNotesCount
      backupBoardNotesLiveCount = boardNotesLiveCount
      backupLastBackupAt = meta?.value ?? null
      if (disk.ok) {
        backupBytes = disk.totalBytes
        backupBytesMeasured = true
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

  // 4. Quotas & Aggregations Ã¢â‚¬â€ every ceiling labeled with its source.
  const TIDB_CLUSTER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024 // 5 GB
  const BACKUP_QUOTA_BYTES = getBackupQuotaBytes()
  const backupQuotaSource = process.env.BACKUP_QUOTA_BYTES
    ? ('env-override' as const)
    : ('cockroachdb-cloud-basic-10gib-default' as const)

  const TOTAL_INFRASTRUCTURE_QUOTA_BYTES = TIDB_CLUSTER_QUOTA_BYTES * 2 + BACKUP_QUOTA_BYTES
  const totalUsedBytes = tidbBooksBytes + tidbNotesBytes + backupBytes
  const totalAvailableBytes = Math.max(0, TOTAL_INFRASTRUCTURE_QUOTA_BYTES - totalUsedBytes)
  const totalPercentUsed = Number(((totalUsedBytes / TOTAL_INFRASTRUCTURE_QUOTA_BYTES) * 100).toFixed(4))

  const body = {
    timestamp: new Date().toISOString(),
    queryDurationMs: Date.now() - t0,
    overall: {
      status: tidbBooksOk && tidbNotesOk ? 'healthy' : backupOk ? 'failover_active' : 'degraded',
      failoverMode: tidbBooksOk && tidbNotesOk ? 'standby' : 'active',
      totalQuotaBytes: TOTAL_INFRASTRUCTURE_QUOTA_BYTES,
      totalQuotaFormatted: formatBytes(TOTAL_INFRASTRUCTURE_QUOTA_BYTES),
      // Users-cluster side-quota is tracked separately (see `usrinfo`
      // block) and intentionally excluded from this total.
      quotaNote: 'TiDB Ãƒâ€”3 (books, notes, users) + CockroachDB; users-cluster quota tracked in `usrinfo` block',
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
    backup: {
      label: 'CockroachDB Backup Engine',
      status: backupOk ? 'online' : 'offline',
      latencyMs: backupLatency,
      quotaBytes: BACKUP_QUOTA_BYTES,
      quotaFormatted: formatBytes(BACKUP_QUOTA_BYTES),
      // Honest ceiling: plan default unless the operator overrode it.
      quotaSource: backupQuotaSource,
      // Honest usage: measured on disk, or explicitly unmeasured.
      usedBytes: backupBytes,
      usedFormatted: backupBytesMeasured ? formatBytes(backupBytes) : 'unmeasured',
      bytesMeasured: backupBytesMeasured,
      availableBytes: Math.max(0, BACKUP_QUOTA_BYTES - backupBytes),
      availableFormatted: backupBytesMeasured
        ? formatBytes(Math.max(0, BACKUP_QUOTA_BYTES - backupBytes))
        : 'unmeasured',
      percentUsed: backupBytesMeasured
        ? Number(((backupBytes / BACKUP_QUOTA_BYTES) * 100).toFixed(4))
        : 0,
      lastBackupAt: backupLastBackupAt,
      tables: {
        books: backupBooksCount,
        pages: backupPagesCount,
        pagesLive: backupPagesLiveCount,
        pagesTombstoned: backupPagesCount - backupPagesLiveCount,
        pageNotes: backupPageNotesCount,
        pageNotesLive: backupPageNotesLiveCount,
        pageNotesTombstoned: backupPageNotesCount - backupPageNotesLiveCount,
        boardNotes: backupBoardNotesCount,
        boardNotesLive: backupBoardNotesLiveCount,
        boardNotesTombstoned: backupBoardNotesCount - backupBoardNotesLiveCount,
      },
    },
    usrinfo: {
      label: 'Users Store (TiDB users_db) Ã¢â‚¬â€ identities, presence, page leases',
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
          books: backupBooksCount,
          pages: backupPagesCount,
          pageNotes: backupPageNotesCount,
          boardNotes: backupBoardNotesCount,
        }
      ),
      repairHint: 'POST /api/storage {"action":"repair"} runs a full TiDB Ã¢â€ â€™ CockroachDB snapshot to heal drift.',
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
 * One-click drift repair: full snapshot TiDB Ã¢â€ â€™ CockroachDB (same engine as /api/backup).
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
    // BOTH engines. Explicit operator action only Ã¢â‚¬â€ never automatic.
    if (body?.action === 'prune') {
      const days = Math.min(3650, Math.max(1, Math.floor(Number(body?.olderThanDays ?? 30))))
      if (!Number.isFinite(days)) {
        return NextResponse.json({ error: 'olderThanDays must be a number' }, { status: 400 })
      }
      const cutoff = new Date(Date.now() - days * 86400000)
      const tidbPruned = await dbBooks.page.deleteMany({ where: { deletedAt: { lt: cutoff } } })
      let backupPruned = 0
      if (isBackupConfigured()) {
        await initBackupTables()
        const res = await dbBackup.backupPage.deleteMany({
          where: { deletedAt: { not: null, lt: cutoff } },
        })
        backupPruned = res.count
      }
      // Diagnostic log retention (Wave E): system_logs is append-only with no
      // TTL Ã¢â‚¬â€ prune entries older than 30 days alongside tombstones.
      // Timestamps are ISO strings; lexical comparison is chronological.
      let logsPruned = 0
      if (isBackupConfigured()) {
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
          `Hard-deleted ${tidbPruned.count} TiDB + ${backupPruned} CockroachDB tombstoned pages older than ${days}d; ${logsPruned} log rows expired`
        ),
        engine: 'System',
        level: 'warn',
      })
      return NextResponse.json({
        message: `Pruned tombstones older than ${days} days`,
        tidb: tidbPruned.count,
        backup: backupPruned,
        logsExpired: logsPruned,
      })
    }
    if (body?.action !== 'repair') {
      return NextResponse.json({ error: 'Unknown action (expected {"action":"repair"} or {"action":"prune"})' }, { status: 400 })
    }
    if (!isBackupConfigured()) {
      return NextResponse.json({ error: 'Backup engine is not configured' }, { status: 400 })
    }
    cache = null
    const result = await snapshotToBackup()
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
