import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import { withTiDBFallback, tursoRestoreBoardNote, replicateNoteUpsert, isNotFoundError } from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/board/[noteId]/restore
 * Reverts a soft-deleted board note.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ noteId: string }> }
) {
  try {
    // Rate-limit BEFORE auth: no unthrottled 401 oracle for token probing.
    const limited = await rlWrite(req, 'board-restore')
    if (limited) return limited
    const gate = requireAdmin(req)
    if (gate) return gate
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const note = await dbNotes.boardNote.update({
          where: { id: noteId },
          data: { deletedAt: null },
        })

        replicateNoteUpsert({
          id: note.id,
          content: note.content,
          color: note.color,
          type: note.type,
          x: note.x,
          y: note.y,
          width: note.width,
          height: note.height,
          rotation: note.rotation,
          z: note.z,
          pinned: note.pinned,
          isBoard: true,
          deletedAt: null,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }).catch(() => {})

        return { note }
      },
      async () => {
        return await tursoRestoreBoardNote(noteId)
      },
      `POST /api/board/${noteId}/restore`,
      'notes'
    )

    logActivity({
      action: 'restore',
      title: 'Board Note Restored',
      details: `Board note #${noteId.slice(0, 8)} restored from trash`,
      engine: 'TiDB Notes',
      level: 'success',
    })

    return NextResponse.json(result)
  } catch (err) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Board note not found' }, { status: 404 })
    }
    console.error('[api/board/[noteId]/restore] failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to restore board note' }, { status: 500 })
  }
}

