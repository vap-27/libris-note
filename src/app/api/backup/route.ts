import { NextResponse } from 'next/server'
import {
  backupAllToTurso,
  restoreAllFromTurso,
  getTursoBackupStats,
  isTursoConfigured,
} from '@/lib/turso'
import { requireAdminForDestructive, requireAdmin } from '@/lib/auth'
import { rlRead, rlDestructive } from '@/lib/rate-limit'
import { logActivity } from '@/lib/logger'
import { sanitizeLogText } from '@/lib/sanitize'

export async function GET(req: Request) {
  try {
    const limited = await rlRead(req, 'backup-status')
    if (limited) return limited
    // Telemetry is sensitive (counts/topology) — gate when admin auth is configured.
    const gate = requireAdmin(req as any)
    if (gate) return gate

    const configured = isTursoConfigured()
    if (!configured) {
      return NextResponse.json({
        configured: false,
        message: 'Backup engine is not configured.',
      })
    }

    const stats = await getTursoBackupStats()
    return NextResponse.json({
      configured: true,
      stats,
    })
  } catch (error) {
    console.error('[api/backup] GET failed:', error)
    return NextResponse.json({ error: 'Failed to query backup status' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const limited = await rlDestructive(req, 'backup-run')
    if (limited) return limited
    const gate = requireAdminForDestructive(req as any)
    if (gate) return gate

    if (!isTursoConfigured()) {
      return NextResponse.json(
        { error: 'Backup engine is not configured' },
        { status: 400 },
      )
    }

    const url = new URL(req.url)
    const action = url.searchParams.get('action')

    if (action === 'restore') {
      // Destructive restore requires explicit confirmation (H-2, M-4).
      let confirm: unknown = url.searchParams.get('confirm')
      let force = url.searchParams.get('force') === '1'
      try {
        const body = await req.clone().json().catch(() => ({} as any))
        if (body && typeof body === 'object') {
          if (typeof (body as any).confirm === 'string') confirm = (body as any).confirm
          if ((body as any).force === true) force = true
        }
      } catch { /* body optional */ }

      if (confirm !== 'RESTORE') {
        return NextResponse.json(
          { error: 'Restore requires explicit confirmation: send {"confirm":"RESTORE"}' },
          { status: 400 }
        )
      }
      const result = await restoreAllFromTurso({ force })
      logActivity({
        action: 'restore',
        title: 'Snapshot Restored',
        details: sanitizeLogText(
          `Restored ${result.restored.pages} pages, ${result.restored.pageNotes} margin notes, ${result.restored.boardNotes} board notes (${result.skippedAsStale} stale skipped, ${result.skippedTombstoned} tombstones kept dead)`
        ),
        engine: 'CockroachDB',
        level: 'warn',
      })
      return NextResponse.json({
        message: 'Restored data from CockroachDB backup into TiDB clusters (last-write-wins)',
        ...result,
      })
    }

    const result = await backupAllToTurso()
    logActivity({
      action: 'backup',
      title: 'Snapshot Backed Up',
      details: sanitizeLogText(
        `Backed up ${result.stats.pages} pages, ${result.stats.pageNotes} margin notes, ${result.stats.boardNotes} board notes`
      ),
      engine: 'CockroachDB',
      level: 'success',
    })
    return NextResponse.json({
      message: 'Backed up all TiDB data to CockroachDB successfully',
      ...result,
    })
  } catch (error) {
    console.error('[api/backup] POST failed:', error)
    return NextResponse.json({ error: 'Failed to run backup operation' }, { status: 500 })
  }
}
