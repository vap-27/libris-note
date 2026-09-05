import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import {
  touchPresence,
  listPresence,
  listPageLocks,
  acquirePageLock,
  releasePageLock,
  refreshOwnLocks,
} from '@/lib/usrinfo'
import { requireAdmin } from '@/lib/auth'
import { rlWrite, rlRead } from '@/lib/rate-limit'
import { normalizeName, PRESENCE_COLORS } from '@/lib/identity'

export const dynamic = 'force-dynamic'

function cleanStr(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001F\u007F]+/g, '')
    .trim()
    .slice(0, max)
}

/** Cheap cross-engine version signal for change detection (best-effort). */
async function readVersions() {
  try {
    const [books, notes] = await Promise.all([
      dbBooks.$queryRaw<Array<{ b: bigint; p: bigint; mb: Date | null; mp: Date | null }>>`
        SELECT (SELECT COUNT(*) FROM Book) AS b,
               (SELECT COUNT(*) FROM Page WHERE deletedAt IS NULL) AS p,
               (SELECT MAX(updatedAt) FROM Book) AS mb,
               (SELECT MAX(updatedAt) FROM Page WHERE deletedAt IS NULL) AS mp`,
      dbNotes.$queryRaw<Array<{ pn: bigint; bn: bigint; mpn: Date | null; mbn: Date | null }>>`
        SELECT (SELECT COUNT(*) FROM PageNote WHERE deletedAt IS NULL) AS pn,
               (SELECT COUNT(*) FROM BoardNote WHERE deletedAt IS NULL) AS bn,
               (SELECT MAX(updatedAt) FROM PageNote) AS mpn,
               (SELECT MAX(updatedAt) FROM BoardNote) AS mbn`,
    ])
    const b = (books?.[0] ?? {}) as any
    const n = (notes?.[0] ?? {}) as any
    return {
      books: Number(b.b ?? 0),
      pages: Number(b.p ?? 0),
      pageNotes: Number(n.pn ?? 0),
      boardNotes: Number(n.bn ?? 0),
      booksMax: b.mb ? new Date(b.mb).toISOString() : null,
      pagesMax: b.mp ? new Date(b.mp).toISOString() : null,
      pageNotesMax: n.mpn ? new Date(n.mpn).toISOString() : null,
      boardNotesMax: n.mbn ? new Date(n.mbn).toISOString() : null,
    }
  } catch {
    return null
  }
}

/**
 * POST /api/presence — heartbeat + optional lock ops.
 * { clientId, tabId, name, color?, pageId?, activity?, lock?: { acquire?, release? } }
 * Locks/releases are best-effort advisory; response always includes the
 * current users + live leases + version signal.
 */
export async function POST(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'presence')
    if (limited) return limited
    const body = await req.json().catch(() => ({}))

    const clientId = cleanStr(body?.clientId, 128)
    const tabId = cleanStr(body?.tabId, 128)
    if (!clientId || !tabId) {
      return NextResponse.json({ error: 'clientId and tabId are required' }, { status: 400 })
    }
    const name = normalizeName(body?.name) ?? 'Guest'
    const color =
      typeof body?.color === 'string' && PRESENCE_COLORS.includes(body.color)
        ? body.color
        : PRESENCE_COLORS[clientId.charCodeAt(0) % PRESENCE_COLORS.length]
    const pageId =
      typeof body?.pageId === 'string' && body.pageId.length > 0 && body.pageId.length <= 128
        ? body.pageId
        : null
    const activity = body?.activity === 'editing' ? 'editing' : 'viewing'

    await touchPresence({ clientId, tabId, name, color, pageId, activity })
    await refreshOwnLocks(clientId)

    let lockResult: { acquired: boolean; holder: unknown } | null = null
    const lockBody = body?.lock as { acquire?: unknown; release?: unknown } | undefined
    if (lockBody && typeof lockBody === 'object') {
      if (typeof lockBody.release === 'string' && lockBody.release.length <= 128) {
        await releasePageLock(lockBody.release, clientId)
      }
      if (typeof lockBody.acquire === 'string' && lockBody.acquire.length <= 128) {
        lockResult = await acquirePageLock(lockBody.acquire, clientId, name, color)
      }
    }

    const [users, locks, versions] = await Promise.all([
      listPresence(),
      listPageLocks(),
      readVersions(),
    ])
    return NextResponse.json({ users, locks, versions, lockResult })
  } catch (err) {
    console.error('[api/presence] POST failed:', err)
    return NextResponse.json({ error: 'Presence unavailable' }, { status: 500 })
  }
}

/** GET /api/presence — live users + leases for the dashboard. */
export async function GET(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlRead(req, 'presence-get')
    if (limited) return limited
    const [users, locks, versions] = await Promise.all([
      listPresence(),
      listPageLocks(),
      readVersions(),
    ])
    return NextResponse.json({ users, locks, versions })
  } catch (err) {
    console.error('[api/presence] GET failed:', err)
    return NextResponse.json({ error: 'Presence unavailable' }, { status: 500 })
  }
}
