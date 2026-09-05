import { NextRequest, NextResponse } from 'next/server'
import { dbBooks } from '@/lib/db'
import { withTiDBFallback, tursoGetBookWithPages, getMergedBookPages } from '@/lib/turso'
import { requireAdmin } from '@/lib/auth'
import { rlRead } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/book[?limit&cursor]
 * Returns the book with its pages, ordered by page number.
 * Optional pagination (Wave E, fully additive): `limit` 1..500 caps rows and
 * `cursor` (a pageNumber) starts after it; response adds
 * `nextCursor: number|null`. Absent params = legacy unbounded behavior.
 * Primary: BOOKS TiDB cluster (cluster A).
 * Dynamic Overflow: Automatically merges pages shifted to Turso when TiDB is low on storage.
 * Failover: Turso database (libSQL) if TiDB is out of storage or down.
 */
export async function GET(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlRead(req, 'book-get')
    if (limited) return limited
    const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '')
    const rawCursor = Number(req.nextUrl.searchParams.get('cursor') ?? '')
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : null
    const cursor = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0
    const data = await withTiDBFallback(
      async () => {
        const book = await dbBooks.book.findFirst({
          orderBy: { createdAt: 'asc' },
        })
        if (!book) {
          throw new Error('No book found in TiDB')
        }
        const pages = await dbBooks.page.findMany({
          where:
            cursor > 0
              ? { bookId: book.id, deletedAt: null, pageNumber: { gt: cursor } }
              : { bookId: book.id, deletedAt: null },
          orderBy: { pageNumber: 'asc' },
          ...(limit != null ? { take: limit + 1 } : {}),
        })
        // Merge with any pages shifted to Turso during low-storage mode.
        // In paginated mode the merged list is windowed by cursor so Turso
        // rows can't duplicate across pages.
        const mergedPages = await getMergedBookPages(pages, book.id)
        let nextCursor: number | null = null
        let outPages = mergedPages
        if (limit != null) {
          const windowed = mergedPages.filter((p) => p.pageNumber > cursor).slice(0, limit)
          outPages = windowed
          nextCursor = windowed.length === limit ? windowed[windowed.length - 1].pageNumber : null
        }
        return { book, pages: outPages, nextCursor }
      },
      async () => {
        const fb = await tursoGetBookWithPages()
        return { ...fb, nextCursor: null as number | null }
      },
      'GET /api/book',
      'books'
    )

    return NextResponse.json(data)
  } catch (err) {
    console.error('[api/book] GET failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to load book' }, { status: 500 })
  }
}

