import { PrismaClient as BooksPrismaClient } from '@/generated/books-client'
import { PrismaClient as NotesPrismaClient } from '@/generated/notes-client'

/**
 * Two independent TiDB clusters:
 *  - dbBooks → TiDB cluster A (port 4000) / books_db   → books + pages
 *  - dbNotes → TiDB cluster B (port 4001) / notes_db   → page notes + board notes
 */

const globalForPrisma = globalThis as unknown as {
  dbBooks?: BooksPrismaClient
  dbNotes?: NotesPrismaClient
}

export const dbBooks =
  globalForPrisma.dbBooks ??
  new BooksPrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

export const dbNotes =
  globalForPrisma.dbNotes ??
  new NotesPrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

// Cached in every env (Wave E): without this, bundled prod runtimes spin a
// fresh pool per worker/module-eval and burst TiDB connections. Pool sizing
// itself stays at Prisma defaults (adequate at this scale); raise via
// ?connection_limit= in the DATABASE_URLs if the pool ever saturates.
globalForPrisma.dbBooks = dbBooks
globalForPrisma.dbNotes = dbNotes
