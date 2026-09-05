import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import { replicatePageUpsert, withTiDBFallback, tursoCreatePage, tursoGetFirstBookId, shouldShiftToTurso, isNotFoundError } from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite, getIdempotentReplay, setIdempotentReplay, hashBody } from '@/lib/rate-limit'
import { sanitizePageHtml, sanitizeLogText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

const MAX_PAGES_PER_BOOK = 2000

/**
 * Books cluster (TiDB A) — page CRUD for the writable book.
 * If TiDB is out of storage or down, automatically falls back to Turso.
 */

/** Margin notes after the insertion point slide up with the pages. Returns false on failure (H-4). */
async function syncNotesAfterInsert(bookId: string, after: number): Promise<boolean> {
  if (after < 0) return true
  try {
    await dbNotes.pageNote.updateMany({
      where: { bookId, pageNumber: { gt: after }, deletedAt: null },
      data: { pageNumber: { increment: 1 } },
    })
    return true
  } catch (err) {
    console.error('[api/pages] notes sync failed:', err)
    return false
  }
}

async function listPages(bookId: string) {
  // Tombstoned pages never list (Wave C).
  return dbBooks.page.findMany({ where: { bookId, deletedAt: null }, orderBy: { pageNumber: 'asc' } })
}

async function firstBookId() {
  const book = await dbBooks.book.findFirst({ orderBy: { createdAt: 'asc' } })
  return book?.id ?? null
}

/**
 * POST /api/pages  { bookId?, afterPageNumber?, content?, title? }
 * Creates a new page. Without afterPageNumber the page is appended at the
 * end; with it, the page is inserted directly after that page number.
 * Primary: TiDB Books Cluster
 * Failover: Turso backup database
 */
export async function POST(req: NextRequest) {
  try {
    const adminDenied = requireAdmin(req)
    if (adminDenied) return adminDenied
    const limited = await rlWrite(req, 'pages-create')
    if (limited) return limited

    // Strict JSON: CSRF-hardening (L-1) — reject non-JSON simple-request smuggling.
    const ct = req.headers.get('content-type') || ''
    if (ct && !ct.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 })
    }

    const body = await req.json().catch(() => ({}))
    const rawContent = typeof body?.content === 'string' ? body.content.slice(0, 20000) : ''
    const rawTitle = typeof body?.title === 'string' ? body.title.slice(0, 200) : ''
    // Sanitize editor HTML server-side (H-1) — stored XSS fix.
    const content = sanitizePageHtml(rawContent, 20000)
    const title = sanitizePageHtml(rawTitle, 200).replace(/<[^>]*>/g, '').trim().slice(0, 200)
    const rawAfter =
      typeof body?.afterPageNumber === 'number' && Number.isFinite(body.afterPageNumber)
        ? body.afterPageNumber
        : undefined

    // Idempotency (M-5): retries with the same key replay the first response.
    // The key is bound to the sanitized intent (M14) so a stale key with a
    // different body can never return the wrong page.
    const idemKey = req.headers.get('x-idempotency-key')
    const idemHash = hashBody({
      bookId: typeof body?.bookId === 'string' ? body.bookId : '',
      after: rawAfter ?? null,
      title,
      content,
    })
    const replay = getIdempotentReplay(idemKey, idemHash)
    if (replay) return NextResponse.json(replay.body, { status: replay.status })

    const result = await withTiDBFallback(
      async () => {
        const bookId = typeof body?.bookId === 'string' && body.bookId ? body.bookId : await firstBookId()
        if (!bookId) throw new Error('No book found in TiDB')

        const book = await dbBooks.book.findUnique({ where: { id: bookId }, select: { id: true } })
        if (!book) throw new Error('Book record not found')

        const pages = await listPages(bookId)
        const numbered = pages.filter((p) => p.pageNumber > 0)
        const maxPage = numbered.length ? Math.max(...numbered.map((p) => p.pageNumber)) : 0
        if (numbered.length >= MAX_PAGES_PER_BOOK) {
          throw new Error('Too many pages: book is full')
        }

        const after = rawAfter !== undefined ? Math.min(Math.max(0, Math.floor(rawAfter)), maxPage) : maxPage

        let notesSyncOk = true
        // Retry the WHOLE transaction on contention (Wave D): the old code
        // retried only the INSERT inside an already-shifted tx, landing the
        // page at the end instead of the requested position. TiDB optimistic
        // write-conflicts (9007) are retried the same way as P2002.
        const isContention = (e: any) => {
          const code = String(e?.code || '')
          const msg = String(e?.message || '')
          return code === 'P2002' || /9007|1213|1205|write conflict|deadlock|try again/i.test(code + ' ' + msg)
        }
        let page: any = null
        let usedAfter = after
        let usedMax = maxPage
        let lastErr: any = null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const created = await dbBooks.$transaction(async (tx) => {
              const fresh = await tx.page.findMany({
                where: { bookId, deletedAt: null },
                orderBy: { pageNumber: 'asc' },
              })
              const nums = fresh.filter((p) => p.pageNumber > 0)
              const curMax = nums.length ? Math.max(...nums.map((p) => p.pageNumber)) : 0
              const curAfter =
                rawAfter !== undefined ? Math.min(Math.max(0, Math.floor(rawAfter)), curMax) : curMax
              if (curAfter < curMax) {
                // Tombstones (negative numbers) must never be shifted.
                await tx.$executeRaw`UPDATE Page SET pageNumber = -pageNumber WHERE bookId = ${bookId} AND pageNumber > ${curAfter} AND deletedAt IS NULL`
                await tx.$executeRaw`UPDATE Page SET pageNumber = -pageNumber + 1 WHERE bookId = ${bookId} AND pageNumber < 0 AND deletedAt IS NULL`
              }
              const row = await tx.page.create({
                data: {
                  bookId,
                  pageNumber: curAfter + 1,
                  chapter: 1,
                  section: 'Writing',
                  title,
                  content,
                },
              })
              return { row, curAfter, curMax }
            })
            page = created.row
            usedAfter = created.curAfter
            usedMax = created.curMax
            lastErr = null
            break
          } catch (e: any) {
            lastErr = e
            if (attempt === 0 && isContention(e)) continue
            throw e
          }
        }
        if (!page) throw lastErr ?? new Error('Failed to create page')

        replicatePageUpsert(page).catch((e) => console.warn('[replicate] page upsert failed:', e?.message || e))
        if (usedAfter < usedMax) notesSyncOk = await syncNotesAfterInsert(bookId, usedAfter)
        if (!notesSyncOk) {
          console.warn('[api/pages] notes shift failed after page insert — client should refreshNotes()')
        }
        return { page, pages: await listPages(bookId), notesSyncOk }
      },
      async () => {
        const bookId =
          (typeof body?.bookId === 'string' && body.bookId) ||
          (await tursoGetFirstBookId()) ||
          'default-book'
        const r = await tursoCreatePage(bookId, rawAfter, title, content)
        return { ...r, notesSyncOk: true }
      },
      'POST /api/pages',
      'books'
    )

    const isShifted = shouldShiftToTurso('books')
    logActivity({
      action: 'create',
      title: 'Page Created',
      details: sanitizeLogText(`Page #${result.page?.pageNumber ?? 'new'} "${title || 'Untitled page'}" created`),
      engine: isShifted ? 'CockroachDB' : 'TiDB Books',
      level: 'success',
    })

    setIdempotentReplay(idemKey, 201, result, idemHash)
    return NextResponse.json(result, { status: 201 })
  } catch (err: any) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 })
    }
    if (/too many pages|book is full/i.test(String(err?.message || ''))) {
      return NextResponse.json({ error: 'Book page limit reached' }, { status: 429 })
    }
    console.error('[api/pages] POST failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 })
  }
}

