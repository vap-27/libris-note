import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import { dbBackup } from '@/lib/db-backup'
import {
  isTursoConfigured,
  getStorageShiftStatus,
  getBackupQuotaBytes,
  TIDB_LOW_STORAGE_THRESHOLD_BYTES,
} from '@/lib/turso'
import { getActivityLogs, logActivity, clearActivityLogs } from '@/lib/logger'
import { requireAdmin, requireAdminForDestructive } from '@/lib/auth'
import { rlRead, rlDestructive } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const ALLOWED_FILTERS = new Set(['all', 'create', 'edit', 'delete', 'restore', 'shift', 'diagnostic', 'backup', 'sync'])

/**
 * GET /api/health
 * Liveness + latency + shift status + activity logs.
 * No open redirect (L-4): always JSON. No raw driver messages (L-5).
 */
export async function GET(req: NextRequest) {
  const limited = await rlRead(req, 'health-get')
  if (limited) return limited
  // Health exposes topology + logs — gate when ADMIN_TOKEN is configured.
  const gate = requireAdmin(req)
  if (gate) return gate

  const filterRaw = req.nextUrl.searchParams.get('filter') || undefined
  const filterAction =
    filterRaw && ALLOWED_FILTERS.has(filterRaw) ? filterRaw : undefined

  const check = async (label: string, ping: () => Promise<unknown>) => {
    const start = Date.now()
    try {
      await ping()
      return {
        ok: true,
        status: 'online',
        cluster: label,
        latencyMs: Date.now() - start,
      }
    } catch (err: any) {
      console.warn(`[api/health] ${label} error`)
      return {
        ok: false,
        status: 'offline_or_full',
        error: 'Unreachable',
        cluster: label,
        latencyMs: Date.now() - start,
      }
    }
  }

  const checkTurso = async () => {
    if (!isTursoConfigured()) {
      return { ok: false, status: 'not_configured', configured: false, latencyMs: 0 }
    }
    const start = Date.now()
    try {
      await dbBackup.backupBook.findFirst({ select: { id: true } })
      return {
        ok: true,
        status: 'online',
        configured: true,
        latencyMs: Date.now() - start,
      }
    } catch {
      return {
        ok: false,
        status: 'error',
        error: 'Unreachable',
        configured: true,
        latencyMs: Date.now() - start,
      }
    }
  }

  const [books, notes, turso] = await Promise.all([
    check('books', () => dbBooks.book.findFirst()),
    check('notes', () => dbNotes.boardNote.findFirst()),
    checkTurso(),
  ])

  const shiftStatus = getStorageShiftStatus()
  const tidbHealthy = books.ok && notes.ok
  const hasTurso = turso.ok
  const serviceOperational = tidbHealthy || hasTurso

  let status = 'ok'
  let mode = 'primary_tidb'

  if (shiftStatus.books.shiftedToTurso || shiftStatus.notes.shiftedToTurso) {
    status = 'ok'
    mode = 'dynamic_shift_to_turso_active'
  } else if (tidbHealthy && hasTurso) {
    status = 'ok'
    mode = 'primary_with_turso_overflow_standby'
  } else if (!tidbHealthy && hasTurso) {
    status = 'ok'
    mode = 'turso_failover_active'
  } else if (tidbHealthy && !hasTurso) {
    status = 'ok'
    mode = 'primary_tidb_only'
  } else {
    status = 'down'
    mode = 'all_databases_offline'
  }

  return NextResponse.json(
    {
      status,
      mode,
      operational: serviceOperational,
      architecture: {
        primaryEngine: 'TiDB Cloud Serverless (Dual Clusters)',
        overflowEngine: 'CockroachDB Backup Engine',
      },
      shiftEngine: shiftStatus,
      primary: {
        books,
        notes,
      },
      overflow: {
        turso,
        thresholdBytes: TIDB_LOW_STORAGE_THRESHOLD_BYTES,
        // Real backup ceiling (operator-overridable) — the dashboard must
        // never hardcode this number.
        quotaBytes: getBackupQuotaBytes(),
        quotaSource: process.env.BACKUP_QUOTA_BYTES ? 'env-override' : 'cockroachdb-cloud-basic-10gib-default',
      },
      activityLogs: await getActivityLogs(50, filterAction),
      checkedAt: new Date().toISOString(),
      dashboard: '/health',
    },
    { status: serviceOperational ? 200 : 503 }
  )
}

/**
 * POST /api/health  { action?: 'clear_logs' } — destructive, admin-only.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))

    if (body?.action === 'clear_logs') {
      const limited = await rlDestructive(req, 'health-clear')
      if (limited) return limited
      const gate = requireAdminForDestructive(req)
      if (gate) return gate
      await clearActivityLogs()
      logActivity({
        action: 'delete',
        title: 'Activity Logs Cleared',
        details: 'Activity log stream cleared by admin',
        engine: 'System',
        level: 'warn',
      })
      return NextResponse.json({
        success: true,
        message: 'Activity logs cleared from database.',
        activityLogs: await getActivityLogs(),
      })
    }

    const limited = await rlRead(req, 'health-post')
    if (limited) return limited
    const gate = requireAdmin(req)
    if (gate) return gate

    return NextResponse.json({
      success: true,
      shiftStatus: getStorageShiftStatus(),
      activityLogs: await getActivityLogs(),
    })
  } catch {
    return NextResponse.json({ error: 'Failed to update health state' }, { status: 500 })
  }
}

/**
 * DELETE /api/health - Clears all diagnostic activity logs (admin-only).
 */
export async function DELETE(req: NextRequest) {
  const limited = await rlDestructive(req, 'health-clear')
  if (limited) return limited
  const gate = requireAdminForDestructive(req)
  if (gate) return gate
  await clearActivityLogs()
  return NextResponse.json({ success: true, message: 'Activity logs cleared from database', activityLogs: await getActivityLogs() })
}
