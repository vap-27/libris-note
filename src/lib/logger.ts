import { isTursoConfigured, initTursoTables } from './turso'
import { dbBackup } from './db-backup'
import { sanitizeLogText } from './sanitize'

/**
 * Unified system & activity logger for Libris.
 * Persists 100% genuine database operations (created, edited, removed, restored, shifted, synced, diagnostics)
 * directly in CockroachDB (`system_logs` table) with an in-memory hot cache.
 * NO fake, test, or mock logs are ever generated.
 */

export interface ActivityLog {
  id: string
  timestamp: string
  timeFormatted: string
  action: 'create' | 'edit' | 'delete' | 'restore' | 'shift' | 'diagnostic' | 'backup' | 'sync'
  title: string
  details: string
  engine: 'TiDB Books' | 'TiDB Notes' | 'CockroachDB' | 'Turso LibSQL' | 'System'
  level: 'info' | 'success' | 'warn' | 'error'
}

// Global hot cache store across hot reloads
const globalForLogs = globalThis as unknown as {
  librisActivityLogs?: ActivityLog[]
}

const activityLogs: ActivityLog[] = globalForLogs.librisActivityLogs ?? []
globalForLogs.librisActivityLogs = activityLogs

/**
 * Log a genuine system or user activity.
 * Writes to in-memory hot cache immediately, and asynchronously persists to CockroachDB `system_logs`.
 */
export function logActivity(entry: {
  action: ActivityLog['action']
  title: string
  details: string
  engine?: ActivityLog['engine']
  level?: ActivityLog['level']
}): ActivityLog {
  const now = new Date()
  const log: ActivityLog = {
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toISOString(),
    timeFormatted: now.toLocaleTimeString(),
    action: entry.action,
    // H-3: truncate + strip control chars so note bodies can't smuggle
    // newlines/HTML into the audit stream or bloat system_logs.
    title: sanitizeLogText(entry.title, 120),
    details: sanitizeLogText(entry.details, 500),
    engine: entry.engine ?? 'System',
    level: entry.level ?? (entry.action === 'delete' ? 'warn' : 'info'),
  }

  // Prepend to hot cache, cap at 100
  activityLogs.unshift(log)
  if (activityLogs.length > 100) {
    activityLogs.pop()
  }

  // Asynchronously persist to CockroachDB system_logs
  if (isTursoConfigured()) {
    dbBackup.systemLog
      .upsert({
        where: { id: log.id },
        create: {
          id: log.id,
          timestamp: log.timestamp,
          timeFormatted: log.timeFormatted,
          action: log.action,
          title: log.title,
          details: log.details,
          engine: log.engine,
          level: log.level,
        },
        update: {},
      })
      .catch((err) => {
        console.warn('[logger] CockroachDB log insert failed:', err?.message || err)
      })
  }

  return log
}

/**
 * Retrieve real activity logs. Queries CockroachDB `system_logs` for persistent storage,
 * falling back to in-memory cache if the backup DB is temporarily unreachable.
 */
export async function getActivityLogs(limit = 50, actionFilter?: string): Promise<ActivityLog[]> {
  if (isTursoConfigured()) {
    try {
      await initTursoTables().catch(() => {})
      const rows = await dbBackup.systemLog.findMany({
        where: actionFilter && actionFilter !== 'all' ? { action: actionFilter } : undefined,
        orderBy: { timestamp: 'desc' },
        take: limit,
      })
      if (rows.length > 0) {
        const dbLogs: ActivityLog[] = rows.map((r) => ({
          id: String(r.id),
          timestamp: String(r.timestamp),
          timeFormatted: String(r.timeFormatted),
          action: String(r.action) as ActivityLog['action'],
          title: String(r.title),
          details: String(r.details),
          engine: String(r.engine) as ActivityLog['engine'],
          level: String(r.level) as ActivityLog['level'],
        }))

        // Refresh hot cache with real database entries
        activityLogs.length = 0
        activityLogs.push(...dbLogs)
        return dbLogs
      }
    } catch (err) {
      console.warn('[logger] Failed to fetch logs from CockroachDB, using hot cache:', err)
    }
  }

  // Hot cache fallback
  if (actionFilter && actionFilter !== 'all') {
    return activityLogs.filter((l) => l.action === actionFilter).slice(0, limit)
  }
  return activityLogs.slice(0, limit)
}

/**
 * Permanently clears all activity logs from both CockroachDB and in-memory cache.
 */
export async function clearActivityLogs(): Promise<void> {
  activityLogs.length = 0
  if (isTursoConfigured()) {
    try {
      await dbBackup.systemLog.deleteMany()
    } catch (err) {
      console.warn('[logger] Failed to clear CockroachDB system_logs table:', err)
    }
  }
}
