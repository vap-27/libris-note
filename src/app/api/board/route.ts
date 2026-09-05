import { NextRequest, NextResponse } from 'next/server'
import { dbNotes } from '@/lib/db'
import {
  withTiDBFallback,
  tursoGetBoardNotes,
  tursoCreateBoardNote,
  tursoPurgeBoardTrash,
  replicateNoteUpsert,
  replicateBoardNotePurge,
  getMergedBoardNotes,
  shouldShiftToTurso,
} from '@/lib/turso'
import { logActivity } from '@/lib/logger'
import { requireAdmin } from '@/lib/auth'
import { rlRead, rlWrite, rlDestructive, getIdempotentReplay, setIdempotentReplay, hashBody } from '@/lib/rate-limit'
import { sanitizeLogText } from '@/lib/sanitize'

export const dynamic = 'force-dynamic'

/**
 * GET /api/board?trash=1
 * Sticky / text-box notes on the board.
 * Primary: Notes cluster.
 * Dynamic Overflow: Merges notes shifted to Turso when TiDB is low on storage.
 * Failover: Turso database.
 */
export async function GET(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlRead(req, 'board-get')
    if (limited) return limited
    const trash = req.nextUrl.searchParams.get('trash') === '1'
    // Wave E: optional `limit` (1..500) + `offset` cap the cliff. Defaults
    // preserve legacy unbounded behavior; offset is best-effort under
    // concurrent inserts (cursor pagination would need a stable key).
    const rawLimit = Number(req.nextUrl.searchParams.get('limit') ?? '')
    const rawOffset = Number(req.nextUrl.searchParams.get('offset') ?? '')
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : null
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
    const result = await withTiDBFallback(
      async () => {
        const notes = await dbNotes.boardNote.findMany({
          where: trash ? { deletedAt: { not: null } } : { deletedAt: null },
          orderBy: [{ z: 'asc' }, { createdAt: 'asc' }],
          ...(limit != null ? { take: limit, skip: offset } : {}),
        })
        // Pass trash through (P6): without it, Turso non-trash rows leak
        // into the trash view whenever the merge runs.
        const merged = await getMergedBoardNotes(notes, trash)
        return { notes: limit != null ? merged.slice(0, limit) : merged }
      },
      async () => {
        return await tursoGetBoardNotes(trash)
      },
      `GET /api/board?trash=${trash ? '1' : '0'}`,
      'notes'
    )

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/board] GET failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to load board notes' }, { status: 500 })
  }
}

const COLORS = ['amber', 'rose', 'sage', 'sky', 'lilac', 'butter']
const TYPES = ['sticky', 'card']

/**
 * POST /api/board  { content?, color, type, x, y, width, height, rotation }
 * Creates a new board note.
 * Primary: TiDB Notes cluster.
 * Failover: Turso backup database.
 */
export async function POST(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    const limited = await rlWrite(req, 'board-create')
    if (limited) return limited
    const idemKey = req.headers.get('x-idempotency-key')
    const body = await req.json().catch(() => ({}))
    // Key bound to intent (M14): same key + different body processes as new.
    const idemHash = hashBody(body)
    const replay = getIdempotentReplay(idemKey, idemHash)
    if (replay) return NextResponse.json(replay.body, { status: replay.status })
    const content = typeof body?.content === 'string' ? body.content : ''
    const color = COLORS.includes(body?.color) ? body.color : 'amber'
    const type = TYPES.includes(body?.type) ? body.type : 'sticky'

    const num = (v: unknown, d: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : d
    const clampNum = (v: number, min: number, max: number) =>
      Math.round(Math.min(max, Math.max(min, v)))

    const x = Math.max(0, clampNum(num(body?.x, 120), 0, 4000))
    const y = Math.max(0, clampNum(num(body?.y, 120), 0, 4000))
    const width = clampNum(num(body?.width, type === 'card' ? 280 : 220), 140, 1600)
    const height = clampNum(num(body?.height, type === 'card' ? 200 : 220), 140, 1600)
    const rotation = clampNum(num(body?.rotation, Math.random() * 6 - 3), -30, 30)

    const result = await withTiDBFallback(
      async () => {
        // Wave D: allocate z inside a transaction with a locking read so two
        // concurrent creates can't mint the same stack position.
        const note = await dbNotes.$transaction(async (tx) => {
          const top = await tx.$queryRaw<Array<{ m: bigint | number | null }>>`
            SELECT COALESCE(MAX(z), 0) AS m FROM BoardNote FOR UPDATE
          `
          const z = Number((top?.[0] as any)?.m ?? 0) + 1
          return await tx.boardNote.create({
            data: {
              content: content.slice(0, 20000),
              color,
              type,
              x,
              y,
              width,
              height,
              rotation,
              z,
            },
          })
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
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        }).catch(() => {})

        return { note }
      },
      async () => {
        return await tursoCreateBoardNote({
          content,
          color,
          type,
          x,
          y,
          width,
          height,
          rotation,
        })
      },
      'POST /api/board',
      'notes'
    )

    const isShifted = shouldShiftToTurso('notes')
    logActivity({
      action: 'create',
      title: 'Board Note Created',
      details: sanitizeLogText(`${type === 'card' ? 'Card note' : 'Sticky note'} created (color: ${color})`),
      engine: isShifted ? 'CockroachDB' : 'TiDB Notes',
      level: 'success',
    })

    setIdempotentReplay(idemKey, 201, result, idemHash)
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    console.error('[api/board] POST failed on both TiDB and Turso:', err)
    return NextResponse.json({ error: 'Failed to create board note' }, { status: 500 })
  }
}

/**
 * DELETE /api/board?emptyTrash=1
 * Permanently purges ALL trashed board notes. Explicit flag required —
 * anything else is a 400, so this can never fire by accident.
 */
export async function DELETE(req: NextRequest) {
  try {
    const limited = await rlDestructive(req, 'board-empty-trash')
    if (limited) return limited
    const gate = requireAdmin(req)
    if (gate) return gate
    if (req.nextUrl.searchParams.get('emptyTrash') !== '1') {
      return NextResponse.json({ error: 'Refusing: send ?emptyTrash=1 to empty the trash' }, { status: 400 })
    }

    const result = await withTiDBFallback(
      async () => {
        const trashed = await dbNotes.boardNote.findMany({
          where: { deletedAt: { not: null } },
          select: { id: true },
        })
        const { count } = await dbNotes.boardNote.deleteMany({
          where: { deletedAt: { not: null } },
        })
        for (const t of trashed) {
          replicateBoardNotePurge(t.id).catch(() => {})
        }
        return { purged: count }
      },
      async () => {
        return await tursoPurgeBoardTrash()
      },
      'DELETE /api/board?emptyTrash=1',
      'notes'
    )

    logActivity({
      action: 'delete',
      title: 'Board Trash Emptied',
      details: sanitizeLogText(`Permanently deleted ${result.purged} trashed board notes`),
      engine: 'TiDB Notes',
      level: 'warn',
    })

    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/board] empty trash failed:', err)
    return NextResponse.json({ error: 'Failed to empty trash' }, { status: 500 })
  }
}

