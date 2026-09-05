/**
 * Comprehensive verification suite:
 * Tests live TiDB Books cluster, TiDB Notes cluster, Turso backup, page saves, note saves, page CRUD.
 */

const BASE = 'http://localhost:3000'

async function assert(desc: string, fn: () => Promise<boolean | void>) {
  process.stdout.write(`  • ${desc} ... `)
  try {
    const res = await fn()
    if (res === false) {
      console.log('❌ FAILED')
      return false
    }
    console.log('✅ PASSED')
    return true
  } catch (err) {
    console.log('❌ ERROR:', err instanceof Error ? err.message : err)
    return false
  }
}

async function run() {
  console.log('\n======================================================')
  console.log('  LIBRIS FULL SYSTEM & DATABASE VERIFICATION SUITE')
  console.log('======================================================\n')

  let passed = 0
  let total = 0

  // 1. Health check
  total++
  if (await assert('Dual TiDB Clusters Health (/api/health)', async () => {
    const r = await fetch(`${BASE}/api/health`)
    const data = await r.json()
    return data.status === 'ok' && data.books.ok && data.notes.ok
  })) passed++

  // 2. Load Book Catalog & Pages
  let bookId = ''
  let page3Id = ''
  total++
  if (await assert('Load Book Catalog & Pages (/api/book)', async () => {
    const r = await fetch(`${BASE}/api/book`)
    const data = await r.json()
    if (!data.book || !Array.isArray(data.pages)) return false
    bookId = data.book.id
    const p3 = data.pages.find((p: any) => p.pageNumber === 3)
    if (p3) page3Id = p3.id
    return data.pages.length >= 3 && Boolean(bookId)
  })) passed++

  // 3. Test Saving Page 3 Content & Title (Autosave)
  total++
  if (page3Id) {
    if (await assert('Save Title & Content on Page 3 (PATCH /api/pages/:id)', async () => {
      const testTitle = 'Meet Project Notes'
      const testContent = 'Hey Meet,\n\nHere is your given project 1!'
      const r = await fetch(`${BASE}/api/pages/${page3Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: testTitle, content: testContent }),
      })
      const data = await r.json()
      return data.page?.title === testTitle && data.page?.content === testContent
    })) passed++
  }

  // 4. Test Pinning and Unpinning Page 3
  total++
  if (page3Id) {
    if (await assert('Pin & Unpin Page (PATCH /api/pages/:id)', async () => {
      // Pin
      const r1 = await fetch(`${BASE}/api/pages/${page3Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: true }),
      })
      const d1 = await r1.json()
      if (!d1.page?.pinned) return false

      // Unpin
      const r2 = await fetch(`${BASE}/api/pages/${page3Id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: false }),
      })
      const d2 = await r2.json()
      return d2.page?.pinned === false
    })) passed++
  }

  // 5. Test Creating a New Page (Atomic Renumbering & Transaction)
  let createdPageId = ''
  total++
  if (await assert('Create New Page at Position (POST /api/pages)', async () => {
    const beforeRes = await fetch(`${BASE}/api/book`)
    const beforeData = await beforeRes.json()
    const countBefore = beforeData.pages.length

    const r = await fetch(`${BASE}/api/pages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bookId,
        afterPageNumber: 2,
        title: 'Temporary Test Page',
        content: 'This page tests atomic insertion and deletion.',
      }),
    })
    const data = await r.json()
    if (!data.page || !Array.isArray(data.pages)) return false
    createdPageId = data.page.id
    return data.page.pageNumber === 3 && data.pages.length === countBefore + 1
  })) passed++

  // 6. Test Deleting the New Page (Closing Numbering Gap)
  total++
  if (createdPageId) {
    if (await assert('Delete Page & Close Numbering Gap (DELETE /api/pages/:id)', async () => {
      const beforeRes = await fetch(`${BASE}/api/book`)
      const beforeData = await beforeRes.json()
      const countBefore = beforeData.pages.length

      const r = await fetch(`${BASE}/api/pages/${createdPageId}`, { method: 'DELETE' })
      const data = await r.json()
      if (!data.pages || !Array.isArray(data.pages)) return false
      const stillExists = data.pages.some((p: any) => p.id === createdPageId)
      return !stillExists && data.pages.length === countBefore - 1
    })) passed++
  }

  // 7. Test Margin Notes Cluster (TiDB Cluster B)
  let createdNoteId = ''
  total++
  if (page3Id) {
    if (await assert('Margin Notes CRUD on Cluster B (/api/pages/:id/notes)', async () => {
      // Create note
      const r1 = await fetch(`${BASE}/api/pages/${page3Id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookId,
          content: 'Test margin note on Page 3',
          color: 'rose',
        }),
      })
      const d1 = await r1.json()
      if (!d1.note?.id) return false
      createdNoteId = d1.note.id

      // Read notes
      const r2 = await fetch(`${BASE}/api/pages/${page3Id}/notes`)
      const d2 = await r2.json()
      const found = d2.notes?.some((n: any) => n.id === createdNoteId)

      // Delete note (soft-delete)
      await fetch(`${BASE}/api/notes/${createdNoteId}`, { method: 'DELETE' })

      return found
    })) passed++
  }

  // 8. Test Board Notes Cluster (TiDB Cluster B)
  let boardNoteId = ''
  total++
  if (await assert('Board Notes CRUD on Cluster B (/api/board)', async () => {
    // Create board note
    const r1 = await fetch(`${BASE}/api/board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Verification Board Note',
        color: 'sky',
        x: 180,
        y: 220,
      }),
    })
    const d1 = await r1.json()
    if (!d1.note?.id) return false
    boardNoteId = d1.note.id

    // Update board note
    const r2 = await fetch(`${BASE}/api/board/${boardNoteId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Updated Board Note', x: 200 }),
    })
    const d2 = await r2.json()
    const updated = d2.note?.content === 'Updated Board Note' && d2.note?.x === 200

    // Cleanup: delete
    await fetch(`${BASE}/api/board/${boardNoteId}`, { method: 'DELETE' })

    return updated
  })) passed++

  // 9. Test Turso Backup API (GET /api/backup)
  total++
  if (await assert('Turso Backup Status & Connectivity (/api/backup)', async () => {
    const r = await fetch(`${BASE}/api/backup`)
    const data = await r.json()
    return data.configured === true && data.stats?.booksCount >= 1 && data.stats?.pagesCount >= 3
  })) passed++

  // 10. Test Turso On-Demand Snapshot Backup (POST /api/backup)
  total++
  if (await assert('Turso On-Demand Snapshot Backup (POST /api/backup)', async () => {
    const r = await fetch(`${BASE}/api/backup`, { method: 'POST' })
    const data = await r.json()
    return data.success === true && data.stats?.pages >= 3 && data.stats?.books >= 1
  })) passed++

  // 11. Test Reading Progress Sync
  total++
  if (bookId) {
    if (await assert('Reading Progress Tracking (PATCH /api/book/progress)', async () => {
      const r = await fetch(`${BASE}/api/book/progress`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookId, page: 3 }),
      })
      const data = await r.json()
      return data.ok === true && data.page === 3
    })) passed++
  }

  console.log('\n------------------------------------------------------')
  console.log(`  VERIFICATION RESULTS: ${passed}/${total} PASSED (${Math.round((passed / total) * 100)}%)`)
  console.log('------------------------------------------------------\n')

  if (passed === total) {
    console.log('🎉 ALL SYSTEMS, DATABASES, SAVINGS, AND BACKUPS ARE FULLY OPERATIONAL!\n')
  } else {
    process.exit(1)
  }
}

run().catch((e) => {
  console.error('Fatal test runner error:', e)
  process.exit(1)
})
