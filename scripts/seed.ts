/**
 * Seeds the BOOKS TiDB cluster with the book + its instruction pages
 * (written on the ruled paper the reader can write on too), and the
 * NOTES cluster with 3 welcome board notes (only when the board is empty,
 * so anything the user deleted stays deleted).
 *
 * Idempotent and non-destructive: pages are upserted by stable
 * (bookId, pageNumber), so re-running refreshes the printed content without
 * wiping the reader's own pages or orphaning margin notes. Requires
 * ALLOW_DESTRUCTIVE_SCRIPT=1 as a seatbelt (it still rewrites pages 0-3).
 */
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile()
  } catch {}
}

import { dbBooks, dbNotes } from '../src/lib/db'

const BOOK = {
  title: 'Libris',
  subtitle: 'A Notebook Bound Like a Book',
  author: '',
  description:
    'A book you write inside: ruled pages, an honest index, margin notes, and a board of pinned thoughts — kept across two TiDB clusters.',
  coverTheme: 'brown',
}

// The printed book is intentionally tiny: one flyleaf + TWO instruction
// pages. Both instruction pages are PINNED so the blank-page sweeper keeps
// them forever; everything after them belongs to the reader.
const P = [
  {
    pageNumber: 0,
    chapter: 0,
    section: 'Flyleaf',
    title: 'Ex Libris',
    content:
      'THIS VOLUME BELONGS TO:\n\n\nWrite on the pages. Add more when you need them. The book keeps everything you trust to it.',
    pinned: false,
  },
  {
    pageNumber: 1,
    chapter: 1,
    section: 'How to use this book',
    title: 'The editor, in ink',
    content:
      '<p>Try the toolbar on this page:</p><p><br></p><p>1. Select a line and press <b>Bold</b></p><p>2. Turn a promise into something <u>underlined</u></p><p>3. Grow lists — bulleted or numbered</p><p><br></p><p>• The <b>H</b> button carves section headings</p><p>• The eraser returns plain ink</p><p><br></p><p><i>What the hand formats, the mind remembers.</i></p>',
    pinned: true,
  },
  {
    pageNumber: 2,
    chapter: 1,
    section: 'How to use this book',
    title: 'Pages, pins & safety',
    content:
      '<p>Turn pages by dragging the left or right edge with your mouse or finger — a quick tap on the edge flips too. Arrow keys also work.</p><p><br></p><p>• Board: drag notes anywhere, pin them to lock in place</p><p>• Two TiDB clusters: books & notes, verified on start</p><p>• The database chip lives at the bottom-left</p><p><br></p><p><i>Add more spreads with the + button above.<br>May the margins be generous.</i></p>',
    pinned: true,
  },
  {
    pageNumber: 3,
    chapter: 1,
    section: 'System Guide',
    title: 'System Features & Storage',
    content:
      '<p>System dashboards & controls:</p><p><br></p><p>• /health — Live cluster health & activity logs</p><p>• /storage — Live database telemetry & backups</p><p>• Dynamic Shift — Auto-shifts to Turso under 10MB</p><p>• Peak Protection — Emergency save under 1MB</p><p>• Felt Board — Draggable stickies & day slider</p><p>• Shortcuts — Press I for Index, Z for Zoom, Ctrl+E for Ink Editor</p><p><br></p><p>All changes persist across dual TiDB clusters.</p>',
    pinned: true,
  },
]

// Welcome notes on the board matching Image 4
const BOARD_NOTES: {
  content: string
  color: string
  type: 'sticky' | 'card'
  x: number
  y: number
  width: number
  height: number
  pinned: boolean
  rotation: number
  z: number
}[] = [
  {
    content:
      'Welcome to your board! Drag me anywhere — grab the dotted bar at my top.',
    color: 'amber',
    type: 'sticky',
    x: 80,
    y: 90,
    width: 240,
    height: 240,
    pinned: false,
    rotation: -1.5,
    z: 1,
  },
  {
    content:
      'I am PINNED. I stay exactly here until you click my pin button to set me free.',
    color: 'rose',
    type: 'sticky',
    x: 370,
    y: 85,
    width: 240,
    height: 240,
    pinned: true,
    rotation: 2.2,
    z: 2,
  },
  {
    content:
      'The rail along the bottom is a timeline of your days — each chip is a day you wrote notes, oldest first.\n\nDrag the empty felt to explore. Click "+ Sticky Note" to compose in ink. Once placed, stickies are permanent!',
    color: 'sage',
    type: 'sticky',
    x: 660,
    y: 110,
    width: 250,
    height: 250,
    pinned: false,
    rotation: -0.8,
    z: 3,
  },
]

async function seedBooks() {
  const existing = await dbBooks.book.findFirst()
  const book = existing ?? (await dbBooks.book.create({ data: BOOK }))

  // Refresh title/theme so re-seeding updates the cover.
  await dbBooks.book.update({
    where: { id: book.id },
    data: {
      title: BOOK.title,
      subtitle: BOOK.subtitle,
      author: BOOK.author,
      description: BOOK.description,
      coverTheme: BOOK.coverTheme,
      lastPage: 1, // new content: start reading from the first page
    },
  })
  // Stable upsert by (bookId, pageNumber): printed pages refresh in place,
  // reader pages (>= 4) and margin notes are never touched. No deleteMany.
  for (const p of P) {
    await dbBooks.page.upsert({
      where: { bookId_pageNumber: { bookId: book.id, pageNumber: p.pageNumber } },
      create: { ...p, bookId: book.id },
      update: {
        chapter: p.chapter,
        section: p.section,
        title: p.title,
        content: p.content,
        pinned: p.pinned,
      },
    })
  }
  console.log(`[books] seeded "${BOOK.title}" with ${P.length} pages`)
}

async function seedNotes() {
  const count = await dbNotes.boardNote.count()
  if (count > 0) {
    console.log(`[notes] board already has ${count} note(s) — leaving them alone`)
    return
  }
  for (const n of BOARD_NOTES) {
    await dbNotes.boardNote.create({ data: n })
  }
  console.log(`[notes] seeded ${BOARD_NOTES.length} instruction notes on the board`)
}

function requireDestructiveOptIn() {
  if (process.env.ALLOW_DESTRUCTIVE_SCRIPT !== '1') {
    console.error('Refusing: set ALLOW_DESTRUCTIVE_SCRIPT=1 to run this script (it rewrites database content).')
    process.exit(1)
  }
}

async function main() {
  requireDestructiveOptIn()
  await seedBooks()
  await seedNotes()
  console.log('SEED DONE')
}

main()
  .catch((e) => { console.error('SEED FAILED:', e); process.exit(1) })
  .finally(async () => { await dbBooks.$disconnect(); await dbNotes.$disconnect() })
