import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import {
  replicatePageUpsert,
  replicatePageDelete,
  withTiDBFallback,
  tursoUpdatePage,
  tursoDeletePage,
  shouldShiftToTurso,
  isNotFoundError,
} from '@/lib/turso'
import { listPageLocks } from '@/lib/usrinfo'
import { SWEEP_MIN_AGE_MS } from '@/lib/identity'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'
import { sanitizePageHtml, sanitizeLogText, isBlankHtml } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

function mapNotFound(err: unknown): NextResponse | null {
  if (isNotFoundError(err)) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 })
  }
  return null
}

/**
 * Books cluster (TiDB A) + notes cluster (TiDB B) sync.
 * Automatic failover to Turso backup if TiDB is out of storage or down.
 *
 * PATCH /api/pages/[pageId]  { content?, title?, pinned? }
 * Edits a writable book page (autosaved from the ruled paper).
 *
 * DELETE /api/pages/[pageId]
 * Removes the page and closes the numbering gap.
 */

async function listPages(bookId: string) {
  // Tombstoned pages never list (Wave C).
  return dbBooks.page.findMany({ where: { bookId, deletedAt: null }, orderBy: { pageNumber: 'asc' } })
}

async function syncNotesAfterDelete(bookId: string, gone: number, pageId: string) {
  try {
    await dbNotes.pageNote.updateMany({
      where: { bookId, pageId, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (gone > 0) {
      await dbNotes.pageNote.updateMany({
        where: { bookId, pageNumber: { gt: gone }, deletedAt: null },
        data: { pageNumber: { decrement: 1 } },
      })
    }
  } catch (err) {
    console.error('[api/pages/:id] notes sync failed:', err)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  try {
    const adminDenied = requireAdmin(req)
    if (adminDenied) return adminDenied
    const limited = await rlWrite(req, 'pages-patch')
    if (limited) return limited

    const { pageId } = await params
    if (!pageId || typeof pageId !== 'string' || pageId.length > 128) {
      return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
    }
    const body = await req.json().catch(() => ({}))
    const data: { content?: string; title?: string; pinned?: boolean } = {}
    if (typeof body?.content === 'string') data.content = sanitizePageHtml(body.content.slice(0, 20000), 20000)
    if (typeof body?.title === 'string') {
      data.title = sanitizePageHtml(body.title.slice(0, 200), 200).replace(/<[^>]*>/g, '').trim().slice(0, 200)
    }
    if (typeof body?.pinned === 'boolean') data.pinned = body.pinned
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Edit lease (Wave 1): a live foreign lock rejects the write with 423 +
    // holder info instead of silently clobbering. Runs before failover so it
    // behaves identically in every engine mode. No clientId = old client.
    const writerId = typeof body?.clientId === 'string' ? body.clientId.slice(0, 128) : ''
    if (writerId) {
      const locks = await listPageLocks()
      const held = locks.find((l) => l.pageId === pageId && l.clientId !== writerId)
      if (held) {
        return NextResponse.json(
          { error: 'Page is being written by someone else', holder: held },
          { status: 423 }
        )
      }
    }

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbBooks.page.findUnique({ where: { id: pageId } })
        if (!existing || existing.deletedAt) throw new Error('Page not found in TiDB')

        const page = await dbBooks.page.update({ where: { id: pageId }, data })
        replicatePageUpsert(page).catch((e) => console.warn('[replicate] page upsert failed:', e?.message || e))
        return { page }
      },
      async () => {
        return await tursoUpdatePage(pageId, data)
      },
      `PATCH /api/pages/${pageId}`,
      'books'
    )

    const isShifted = shouldShiftToTurso('books')
    logActivity({
      action: 'edit',
      title: 'Page Edited',
      details: sanitizeLogText(`Page #${result.page?.pageNumber ?? pageId} updated${data.title ? ` (Title: "${data.title}")` : ''}`),
      engine: isShifted ? 'CockroachDB' : 'TiDB Books',
      level: 'info',
    })

    return NextResponse.json(result)
  } catch (err) {
    const nf = mapNotFound(err)
    if (nf) return nf
    console.error('[api/pages/:id] PATCH failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to update page' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  try {
    const adminDenied = requireAdmin(req)
    if (adminDenied) return adminDenied
    const limited = await rlWrite(req, 'pages-delete')
    if (limited) return limited
    const { pageId } = await params
    if (!pageId || typeof pageId !== 'string' || pageId.length > 128) {
      return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
    }
    // Sweep calls (?sweep=1) may only remove pages that are STILL blank and
    // unpinned on the server — a stale client must never nuke real content.
    // Explicit user removes (confirm dialog) bypass this guard by design.
    const sweepOnly = req.nextUrl.searchParams.get('sweep') === '1'

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbBooks.page.findUnique({ where: { id: pageId } })
        if (!existing || existing.deletedAt) throw new Error('Page not found in TiDB')

        if (existing.pageNumber === 0) {
          throw new Error('The flyleaf cannot be removed')
        }

        if (
          sweepOnly &&
          (existing.pinned ||
            !isBlankHtml(existing.content) ||
            (existing.title ?? '').trim().length !== 0)
        ) {
          throw new Error('Page is not blank — refusing auto-sweep')
        }

        // Cross-device freshness (Wave 1): no sweeper — this device or any
        // other — may take a page younger than the grace window, so a fresh
        // page survives even when a second reader already sees it as blank.
        if (
          sweepOnly &&
          Date.now() - existing.createdAt.getTime() < SWEEP_MIN_AGE_MS
        ) {
          throw new Error('Page is too fresh to sweep — try again later')
        }

        // Soft delete (Wave C): the tombstone parks at a negative number so
        // its unique slot frees up, then live rows above close the gap. The
        // tombstone itself never renumbers, and merges/restore ignore it —
        // deleted pages stay deleted everywhere.
        const deletedAt = new Date()
        await dbBooks.$transaction(async (tx) => {
          // Tombstone slot must be unique even across delete → recreate →
          // delete cycles of the same number: sink below any existing negative.
          const minAgg = await tx.page.aggregate({
            where: { bookId: existing.bookId, pageNumber: { lt: 0 } },
            _min: { pageNumber: true },
          })
          const tombNumber = Math.min(-existing.pageNumber, (minAgg._min.pageNumber ?? 0) - 1)
          await tx.page.update({
            where: { id: pageId },
            data: { deletedAt, pageNumber: tombNumber },
          })
          if (existing.pageNumber > 0) {
            await tx.$executeRaw`UPDATE Page SET pageNumber = pageNumber - 1 WHERE bookId = ${existing.bookId} AND pageNumber > ${existing.pageNumber} AND deletedAt IS NULL`
          }
        })

        replicatePageDelete(pageId).catch(() => {})
        await syncNotesAfterDelete(existing.bookId, existing.pageNumber, pageId)
        return { pages: await listPages(existing.bookId) }
      },
      async () => {
        return await tursoDeletePage(pageId, sweepOnly ? { sweep: true } : undefined)
      },
      `DELETE /api/pages/${pageId}`,
      'books'
    )

    logActivity({
      action: 'delete',
      title: 'Page Removed',
      details: `Page #${pageId} removed and numbering sequence re-balanced`,
      engine: 'TiDB Books',
      level: 'warn',
    })

    return NextResponse.json(result)
  } catch (err: any) {
    if (err?.message === 'The flyleaf cannot be removed') {
      return NextResponse.json({ error: 'The flyleaf cannot be removed' }, { status: 400 })
    }
    if (err?.message === 'Page is not blank — refusing auto-sweep') {
      return NextResponse.json({ error: 'Page is not blank — refusing auto-sweep' }, { status: 409 })
    }
    if (err?.message === 'Page is too fresh to sweep — try again later') {
      return NextResponse.json({ error: 'Page is too fresh to sweep — try again later' }, { status: 409 })
    }
    const nf = mapNotFound(err)
    if (nf) return nf
    console.error('[api/pages/:id] DELETE failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to delete page' }, { status: 500 })
  }
}

