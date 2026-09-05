import { NextRequest, NextResponse } from 'next/server'
import { dbNotes, dbBooks } from '@/lib/db'
import { withTiDBFallback, tursoSearchNotes } from '@/lib/turso'
import { requireAdmin } from '@/lib/auth'
import { rlRead } from '@/lib/rate-limit'
import { escapeLikeWildcards } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

/**
 * GET /api/notes/search?q=...
 * Searches ALL margin notes and enriches each result with page title/section.
 * Primary: TiDB Notes & Books clusters.
 * Failover: Turso backup database.
 */
export async function GET(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlRead(req, 'notes-search')
    if (limited) return limited
    const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 200)
    if (q.length < 2) {
      return NextResponse.json({ notes: [] })
    }

    const result = await withTiDBFallback(
      async () => {
        // Prisma `contains` does not escape LIKE wildcards on MySQL/TiDB, so
        // q=%% would match everything. MySQL treats backslash as the default
        // LIKE escape, so a pre-escaped pattern stays literal (P4).
        const notes = await dbNotes.pageNote.findMany({
          where: { content: { contains: escapeLikeWildcards(q) }, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 30,
        })
        // H-5 fix: also search Turso-shifted rows and merge (dedup by id).
        let tursoNotes: any[] = []
        try {
          const t = await tursoSearchNotes(q)
          tursoNotes = t.notes || []
        } catch { /* best-effort merge */ }
        const seen = new Set(notes.map((n) => n.id))
        // Wave D: re-sort merged newest-first (both halves arrive desc, but
        // concatenation alone would always rank Turso hits last).
        const merged = [...notes, ...tursoNotes.filter((n) => !seen.has(n.id))]
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          )
          .slice(0, 30)
        if (merged.length === 0) {
          return { notes: [] }
        }

        // Enrich TiDB-origin notes with page info; Turso notes already enriched.
        const needEnrich = merged.filter((n) => !('pageTitle' in n))
        const pageIds = [...new Set(needEnrich.map((n) => n.pageId))]
        const pages = pageIds.length
          ? await dbBooks.page.findMany({ where: { id: { in: pageIds } } })
          : []
        const pageById = new Map(pages.map((p) => [p.id, p]))

        return {
          notes: merged.map((n) => {
            if ('pageTitle' in n) return n
            const page = pageById.get(n.pageId)
            return {
              ...n,
              pageTitle: page?.title ?? 'Unknown page',
              section: page?.section ?? '',
            }
          }),
        }
      },
      async () => {
        return await tursoSearchNotes(q)
      },
      `GET /api/notes/search`,
      'notes'
    )

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/notes/search] GET failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to search notes' }, { status: 500 })
  }
}

