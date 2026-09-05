import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import { withTiDBFallback, tursoGetBookNotes, getMergedBookPageNotes } from '@/lib/turso'
import { requireAdmin } from '@/lib/auth'
import { rlRead } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * GET /api/notes?bookId=...&trash=1
 * Margin notes for a book.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function GET(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlRead(req, 'notes-get')
    if (limited) return limited
    const bookId = req.nextUrl.searchParams.get('bookId')
    if (!bookId) {
      return NextResponse.json({ error: 'bookId is required' }, { status: 400 })
    }
    if (bookId.length > 128) {
      return NextResponse.json({ error: 'Invalid bookId' }, { status: 400 })
    }
    const trash = req.nextUrl.searchParams.get('trash') === '1'
    // Wave E: optional `limit` (1..2000, default cap 2000) + `offset`.
    const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '')
    const rawOffset = Number(req.nextUrl.searchParams.get('offset') ?? '')
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2000, Math.floor(rawLimit)) : 2000
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0

    const result = await withTiDBFallback(
      async () => {
        const notes = await dbNotes.pageNote.findMany({
          where: trash ? { bookId, deletedAt: { not: null } } : { bookId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          take: limit,
          skip: offset,
        })
        // H-5 fix: merge Turso-shifted rows so they don't look deleted —
        // including Turso-side trash (P5), which was previously invisible.
        const merged = await getMergedBookPageNotes(notes, bookId, trash)
        return { notes: merged }
      },
      async () => {
        return await tursoGetBookNotes(bookId, trash)
      },
      `GET /api/notes?bookId=${bookId}&trash=${trash ? '1' : '0'}`
    )

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/notes] GET failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to load notes' }, { status: 500 })
  }
}

