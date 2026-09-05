import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import {
  withTiDBFallback,
  tursoUpdateBoardNote,
  tursoDeleteBoardNote,
  tursoPurgeBoardNote,
  replicateNoteUpsert,
  replicateBoardNoteDelete,
  replicateBoardNotePurge,
  shouldShiftToTurso,
  isNotFoundError,
} from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlWrite } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const NOTE_COLORS = ['amber', 'rose', 'sage', 'sky', 'lilac', 'butter']
const NOTE_TYPES = ['sticky', 'card']

function clampNum(v: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, v)))
}

/** PATCH /api/board/[noteId]  { content?, color?, x?, y?, width?, height?, rotation?, z?, pinned? }
 * Updates a board note — used for drag, resize, edit, recolor, re-order, pin/unpin.
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
    const limited = await rlWrite(req, 'board-patch')
    if (limited) return limited
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }
    const body = await req.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }

    const data: Record<string, number | string | boolean> = {}
    if (typeof body.content === 'string') data.content = body.content.slice(0, 20000)
    if (typeof body.color === 'string' && NOTE_COLORS.includes(body.color)) data.color = body.color
    if (typeof body.type === 'string' && NOTE_TYPES.includes(body.type)) data.type = body.type
    if (typeof body.pinned === 'boolean') data.pinned = body.pinned
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const x = num(body.x); if (x != null) data.x = clampNum(x, 0, 4000)
    const y = num(body.y); if (y != null) data.y = clampNum(y, 0, 4000)
    const w = num(body.width); if (w != null) data.width = clampNum(w, 140, 1600)
    const h = num(body.height); if (h != null) data.height = clampNum(h, 140, 1600)
    const rot = num(body.rotation); if (rot != null) data.rotation = clampNum(rot, -30, 30)
    const z = num(body.z); if (z != null) data.z = clampNum(z, 0, 10000)
    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbNotes.boardNote.findUnique({ where: { id: noteId } })
        if (!existing) throw new Error('Note not found in TiDB')
        if (existing.deletedAt) {
          throw new Error('This note is in the trash')
        }

        const note = await dbNotes.boardNote.update({ where: { id: noteId }, data })
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
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }).catch(() => {})

        return { note }
      },
      async () => {
        return await tursoUpdateBoardNote(noteId, data)
      },
      `PATCH /api/board/${noteId}`,
      'notes'
    )

    const isShifted = shouldShiftToTurso('notes')
    logActivity({
      action: 'edit',
      title: 'Board Note Edited',
      details: `Board note #${noteId.slice(0, 8)} updated`,
      engine: isShifted ? 'CockroachDB' : 'TiDB Notes',
      level: 'info',
    })

    return NextResponse.json(result)
  } catch (err: any) {
    if (err?.message === 'This note is in the trash') {
      return NextResponse.json({ error: 'This note is in the trash' }, { status: 409 })
    }
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Board note not found' }, { status: 404 })
    }
    console.error('[api/board/[noteId]] PATCH failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to update board note' }, { status: 500 })
  }
}

/**
 * DELETE /api/board/[noteId]
 * Soft-deletes a board note (moves to trash).
 * DELETE /api/board/[noteId]?hard=1 permanently purges a TRASHED note.
 * The hard path refuses live rows so a stale client can never skip trash.
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
    const limited = await rlWrite(req, 'board-delete')
    if (limited) return limited
    const { noteId } = await params
    if (!noteId || noteId.length > 128) {
      return NextResponse.json({ error: 'Invalid note id' }, { status: 400 })
    }
    const hard = req.nextUrl.searchParams.get('hard') === '1'

    if (hard) {
      const purged = await withTiDBFallback(
        async () => {
          const existing = await dbNotes.boardNote.findUnique({ where: { id: noteId } })
          if (!existing) throw new Error('Note not found in TiDB')
          if (!existing.deletedAt) {
            throw new Error('Move to trash first — only trashed notes can be purged')
          }
          await dbNotes.boardNote.delete({ where: { id: noteId } })
          replicateBoardNotePurge(noteId).catch(() => {})
          return { purged: true, id: noteId }
        },
        async () => {
          await tursoPurgeBoardNote(noteId)
          return { purged: true, id: noteId }
        },
        `DELETE /api/board/${noteId}?hard=1`,
        'notes'
      )
      logActivity({
        action: 'delete',
        title: 'Board Note Purged',
        details: `Board note #${noteId.slice(0, 8)} permanently deleted`,
        engine: 'TiDB Notes',
        level: 'warn',
      })
      return NextResponse.json(purged)
    }

    const result = await withTiDBFallback(
      async () => {
        const existing = await dbNotes.boardNote.findUnique({ where: { id: noteId } })
        if (!existing) throw new Error('Note not found in TiDB')
        if (existing.deletedAt) {
          return { note: existing }
        }
        const note = await dbNotes.boardNote.update({
          where: { id: noteId },
          data: { deletedAt: new Date() },
        })

        replicateBoardNoteDelete(noteId, true).catch(() => {})
        return { note }
      },
      async () => {
        return await tursoDeleteBoardNote(noteId)
      },
      `DELETE /api/board/${noteId}`,
      'notes'
    )

    logActivity({
      action: 'delete',
      title: 'Board Note Removed',
      details: `Board note #${noteId.slice(0, 8)} moved to trash`,
      engine: 'TiDB Notes',
      level: 'warn',
    })

    return NextResponse.json(result)
  } catch (err: any) {
    if (isNotFoundError(err)) {
      return NextResponse.json({ error: 'Board note not found' }, { status: 404 })
    }
    if (err?.message === 'Move to trash first — only trashed notes can be purged') {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    console.error('[api/board/[noteId]] DELETE failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to delete board note' }, { status: 500 })
  }
}

