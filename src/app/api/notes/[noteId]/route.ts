import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import {
  withTiDBFallback,
  tursoUpdatePageNote,
  tursoDeletePageNote,
  replicateNoteUpsert,
  replicatePageNoteDelete,
  shouldShiftToTurso,
  isNotFoundError,
} from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const NOTE_COLORS = ['amber', 'rose', 'sage', 'sky', 'lilac', 'butter']

/** PATCH /api/notes/[noteId]  { content?, color? }
 * Updates a margin note.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ noteId: string }> }
) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'notes-patch')
    if (limited) return limited
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }
    const body = await req.json().catch(() => null)

    const data: { content?: string; color?: string } = {}
    if (typeof body?.content === 'string' && body.content.trim()) {
      data.content = body.content.trim().slice(0, 20000)
    }
    if (typeof body?.color === 'string' && NOTE_COLORS.includes(body.color)) {
      data.color = body.color
    }
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbNotes.pageNote.findUnique({ where: { id: noteId } })
        if (!existing) throw new Error('Note not found in TiDB')
        if (existing.deletedAt) {
          throw new Error('This note is in the trash')
        }

        const note = await dbNotes.pageNote.update({ where: { id: noteId }, data })
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
        return await tursoUpdatePageNote(noteId, data)
      },
      `PATCH /api/notes/${noteId}`,
      'notes'
    )

    const isShifted = shouldShiftToTurso('notes')
    logActivity({
      action: 'edit',
      title: 'Margin Note Edited',
      details: `Margin note #${noteId.slice(0, 8)} updated`,
      engine: isShifted ? 'CockroachDB' : 'TiDB Notes',
      level: 'info',
    })

    return NextResponse.json(result)
  } catch (err: any) {
    if (err?.message === 'This note is in the trash') {
      return NextResponse.json({ error: 'This note is in the trash' }, { status: 409 })
    }
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }
    console.error('[api/notes/[noteId]] PATCH failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to update note' }, { status: 500 })
  }
}

/**
 * DELETE /api/notes/[noteId]
 * Soft-deletes a margin note.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ noteId: string }> }
) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'notes-delete')
    if (limited) return limited
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbNotes.pageNote.findUnique({ where: { id: noteId } })
        if (!existing) throw new Error('Note not found in TiDB')
        if (existing.deletedAt) return { note: existing }

        const note = await dbNotes.pageNote.update({
          where: { id: noteId },
          data: { deletedAt: new Date() },
        })

        replicatePageNoteDelete(noteId, true).catch(() => {})
        return { note }
      },
      async () => {
        return await tursoDeletePageNote(noteId)
      },
      `DELETE /api/notes/${noteId}`,
      'notes'
    )

    logActivity({
      action: 'delete',
      title: 'Margin Note Removed',
      details: `Margin note #${noteId.slice(0, 8)} soft-deleted`,
      engine: 'TiDB Notes',
      level: 'warn',
    })

    return NextResponse.json(result)
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 })
    }
    console.error('[api/notes/[noteId]] DELETE failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to delete note' }, { status: 500 })
  }
}

