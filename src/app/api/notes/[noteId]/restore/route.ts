import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import { withTiDBFallback, tursoRestorePageNote, replicateNoteUpsert, isNotFoundError } from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/notes/[noteId]/restore
 * Reverts a soft-deleted margin note.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ noteId: string }> }
) {
  try {
    // Rate-limit BEFORE auth: no unthrottled 401 oracle for token probing.
    const limited = await rlWrite(req, 'notes-restore')
    if (limited) return limited
    const gate = requireAdmin(req)
    if (gate) return gate
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const note = await dbNotes.pageNote.update({
          where: { id: noteId },
          data: { deletedAt: null },
        })

        replicateNoteUpsert({
          id: note.id,
          bookId: note.bookId,
          pageId: note.pageId,
          pageNumber: note.pageNumber,
          content: note.content,
          color: note.color,
          isBoard: false,
          deletedAt: null,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }).catch(() => {})

        return { note }
      },
      async () => {
        return await tursoRestorePageNote(noteId)
      },
      `POST /api/notes/${noteId}/restore`,
      'notes'
    )

    logActivity({
      action: 'restore',
      title: 'Margin Note Restored',
      details: `Margin note #${noteId.slice(0, 8)} restored`,
      engine: 'TiDB Notes',
      level: 'success',
    })

    return NextResponse.json(result)
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }
    console.error('[api/notes/[noteId]/restore] failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to restore note' }, { status: 500 })
  }
}

