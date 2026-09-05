import { NextRequest, NextResponse } from 'next/server'
import { dbBooks } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'
import { withTiDBFallback, tursoUpdateProgress, isNotFoundError } from '@/lib/turso'

export const dynamic = 'force-dynamic'

/**
 * PATCH /api/book/progress  { page: number }
 * Stores the reader's current page on the books cluster so the book can
 * be retrieved exactly where it was left.
 */
export async function PATCH(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'progress')
    if (limited) return limited
    const body = await req.json().catch(() => null)
    const page = typeof body?.page === 'number' && Number.isFinite(body.page)
      ? Math.max(1, Math.round(body.page))
      : null
    if (page == null) {
      return NextResponse.json({ error: 'page is required' }, { status: 400 })
    }

    // Wave D: progress participates in failover like every other write, so a
    // books-cluster outage no longer strands the reader at a stale page.
    const result = await withTiDBFallback(
      async () => {
        const book = await dbBooks.book.findFirst({ orderBy: { createdAt: 'asc' } })
        if (!book) {
          throw new Error('No book found in TiDB')
        }

        // the reading position must live inside the book: a blank trailing page
        // can be swept after the position is stored, and a page can be removed,
        // so clamp to the last numbered page that actually exists
        const maxAgg = await dbBooks.page.aggregate({
          where: { bookId: book.id, pageNumber: { gt: 0 }, deletedAt: null },
          _max: { pageNumber: true },
        })
        const maxPage = Math.max(1, maxAgg._max.pageNumber ?? 1)
        const stored = Math.min(page, maxPage)

        await dbBooks.book.update({
          where: { id: book.id },
          data: { lastPage: stored },
        })
        return { ok: true as const, page: stored }
      },
      async () => {
        const r = await tursoUpdateProgress(page)
        return { ok: true as const, page: r.page }
      },
      'PATCH /api/book/progress',
      'books'
    )
    return NextResponse.json(result)
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'No book found' }, { status: 404 })
    }
    console.error('[api/book/progress] PATCH failed:', err)
    return NextResponse.json({ error: 'Failed to save reading progress' }, { status: 500 })
  }
}
