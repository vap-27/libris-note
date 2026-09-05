/**
 * Restores the pristine demo state after verification runs:
 * - board notes: original positions / contents / pin flags / today's dates
 * - reading progress: back to page 1
 * Run scripts/seed.ts afterwards if pages also need a refresh.
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile()
  } catch {}
}

import { dbBooks, dbNotes } from '../src/lib/db'

async function main() {
  if (process.env.ALLOW_DESTRUCTIVE_SCRIPT !== '1') {
    console.error('Refusing: set ALLOW_DESTRUCTIVE_SCRIPT=1 to run this script (it overwrites notes).')
    process.exit(1)
  }
  const amber = await dbNotes.boardNote.findFirst({ where: { color: 'amber' } })
  if (amber) await dbNotes.boardNote.update({ where: { id: amber.id }, data: { createdAt: new Date(), x: 60, y: 70, rotation: -2 } })
  const sage = await dbNotes.boardNote.findFirst({ where: { color: 'sage' } })
  if (sage) await dbNotes.boardNote.update({ where: { id: sage.id }, data: { x: 360, y: 120, rotation: 2.4, pinned: true } })
  const card = await dbNotes.boardNote.findFirst({ where: { type: 'card' } })
  if (card) await dbNotes.boardNote.update({ where: { id: card.id }, data: { x: 640, y: 80, rotation: -1, pinned: false } })
  console.log('[board] demo positions/dates restored')

  const book = await dbBooks.book.findFirst()
  if (book) {
    await dbBooks.book.update({ where: { id: book.id }, data: { lastPage: 1 } })
    console.log('[book] reading position reset to page 1')
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await dbBooks.$disconnect(); await dbNotes.$disconnect() })
