import { NextRequest, NextResponse } from 'next/server'
import { dbBooks, dbNotes } from '@/lib/db'
import {
  withTiDBFallback,
  tursoGetPageNotes,
  tursoCreatePageNote,
  replicateNoteUpsert,
  getMergedPageNotes,
  shouldShiftToTurso,
  isNotFoundError,
} from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlRead, rlWrite, getIdempotentReplay, setIdempotentReplay, hashBody } from '@/lib/rate-limit'
import { sanitizeLogText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

const PAGE_NOTE_COLORS = ['amber', 'rose', 'sage', 'sky', 'lilac', 'butter']

/**
 * GET /api/pages/[pageId]/notes
 * All margin notes for one page.
 * Primary: BOOKS cluster (page meta) + NOTES cluster (notes).
 * Dynamic Overflow: Merges notes shifted to Turso during low-storage mode.
 * Failover: Turso database.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const gate = requireAdmin(_req)
    if (gate) return gate
    const limited = await rlRead(_req, 'page-notes-get')
    if (limited) return limited
    const { pageId } = await params
    if (!pageId || pageId.length > 128) {
      return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
    }
    const result = await withTiDBFallback(
      async () => {
        const page = await dbBooks.page.findUnique({ where: { id: pageId } })
        if (!page || page.deletedAt) {
          throw new Error('Page not found in TiDB')
        }
        const notes = await dbNotes.pageNote.findMany({
          where: { pageId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
        })
        const merged = await getMergedPageNotes(notes, pageId)
        return { page, notes: merged }
      },
      async () => {
        return await tursoGetPageNotes(pageId)
      },
      `GET /api/pages/${pageId}/notes`,
      'notes'
    )

    return NextResponse.json(result)
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 })
    }
    console.error('[api/pages/[pageId]/notes] GET failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to load page notes' }, { status: 500 })
  }
}

/**
 * POST /api/pages/[pageId]/notes  { content, color }
 * Creates a margin note on the page.
 * Primary: TiDB Notes cluster (with books check).
 * Failover: Turso backup database.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ pageId: string }> }
) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'page-notes-create')
    if (limited) return limited
    const { pageId } = await params
    if (!pageId || pageId.length > 128) {
      return NextResponse.json({ error: 'Invalid page id' }, { status: 400 })
    }
    const body = await req.json().catch(() => null)
    const content = typeof body?.content === 'string' ? body.content.trim().slice(0, 20000) : ''
    const color =
      typeof body?.color === 'string' && PAGE_NOTE_COLORS.includes(body.color) ? body.color : 'amber'

    if (!content) {
      return NextResponse.json({ error: 'Note content is required' }, { status: 400 })
    }

    // One key per intent, bound to the note body (Wave D): timeout retries
    // replay instead of minting twins.
    const idemKey = req.headers.get('x-idempotency-key')
    const idemHash = hashBody({ pageId, content, color })
    const replay = getIdempotentReplay(idemKey, idemHash)
    if (replay) return NextResponse.json(replay.body, { status: replay.status })

    const result = await withTiDBFallback(
      async () => {
        const page = await dbBooks.page.findUnique({ where: { id: pageId } })
        if (!page || page.deletedAt) {
          throw new Error('Page not found in TiDB')
        }

        const note = await dbNotes.pageNote.create({
          data: {
            bookId: page.bookId,
            pageId: page.id,
            pageNumber: page.pageNumber,
            content,
            color,
          },
        })
        replicateNoteUpsert({
          id: note.id,
          bookId: note.bookId,
          pageId: note.pageId,
          pageNumber: note.pageNumber,
          content: note.content,
          color: note.color,
          isBoard: false,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }).catch(() => {})

        return { note }
      },
      async () => {
        return await tursoCreatePageNote({ pageId, content, color })
      },
      `POST /api/pages/${pageId}/notes`,
      'notes'
    )

    const isShifted = shouldShiftToTurso('notes')
    logActivity({
      action: 'create',
      title: 'Margin Note Created',
      details: sanitizeLogText(`Margin note added to page #${pageId.slice(0, 8)} (color: ${color})`),
      engine: isShifted ? 'CockroachDB' : 'TiDB Notes',
      level: 'success',
    })

    setIdempotentReplay(idemKey, 201, result, idemHash)
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 })
    }
    console.error('[api/pages/[pageId]/notes] POST failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to create note' }, { status: 500 })
  }
}

