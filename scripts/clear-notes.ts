/**
 * Clears ALL notes (margin notes + board notes, including trashed ones) from
 * the notes cluster so the user starts with a clean slate and writes every
 * note manually. Book page content (books cluster) is NOT touched.
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile()
  } catch {}
}

import { dbNotes } from '../src/lib/db'

async function main() {
  if (process.env.ALLOW_DESTRUCTIVE_SCRIPT !== '1') {
    console.error('Refusing: set ALLOW_DESTRUCTIVE_SCRIPT=1 to run this script (it deletes all notes).')
    process.exit(1)
  }
  const pageNotes = await dbNotes.pageNote.deleteMany({})
  const boardNotes = await dbNotes.boardNote.deleteMany({})
  console.log(`Deleted ${pageNotes.count} page notes and ${boardNotes.count} board notes.`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await dbNotes.$disconnect()
  })
