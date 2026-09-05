import { afterEach, describe, expect, it } from 'vitest'
import {
  isNonFailoverError,
  isNotFoundError,
  buildDivergence,
  getStorageShiftStatus,
  TIDB_LOW_STORAGE_THRESHOLD_BYTES,
} from '../../src/lib/turso'

describe('isNonFailoverError — validation must never fork engines', () => {
  const noFork: Array<[string, any]> = [
    ['P2002 code', { code: 'P2002', message: 'Unique constraint' }],
    ['unique violation', new Error('Unique constraint failed')],
    ['flyleaf', new Error('The flyleaf cannot be removed')],
    ['sweep refusal', new Error('Page is not blank — refusing auto-sweep')],
    ['trash', new Error('This note is in the trash')],
    ['nothing to update', new Error('Nothing to update')],
    ['too many', new Error('Too many pages: book is full')],
    ['unauthorized', new Error('Unauthorized')],
    ['confirm', new Error('Restore requires explicit confirmation')],
  ]
  for (const [name, err] of noFork) {
    it(`no failover: ${name}`, () => {
      expect(isNonFailoverError(err)).toBe(true)
    })
  }
  const fork: Array<[string, any]> = [
    ['disk full', Object.assign(new Error('ER_DISK_FULL'), { code: 'ER_DISK_FULL' })],
    ['conn refused', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['timeout', new Error('Timed out waiting for connection')],
  ]
  for (const [name, err] of fork) {
    it(`failover allowed: ${name}`, () => {
      expect(isNonFailoverError(err)).toBe(false)
    })
  }
})

describe('isNotFoundError', () => {
  it('matches miss phrasing only', () => {
    expect(isNotFoundError(new Error('Page not found in TiDB'))).toBe(true)
    expect(isNotFoundError(new Error('Page not found (deleted)'))).toBe(true)
    expect(isNotFoundError(new Error('No book found'))).toBe(true)
    expect(isNotFoundError(new Error('ER_DISK_FULL'))).toBe(false)
    expect(isNotFoundError(null)).toBe(false)
  })
})

describe('buildDivergence', () => {
  it('flags any table delta', () => {
    const clean = buildDivergence(
      { books: 1, pages: 4, pageNotes: 0, boardNotes: 5 },
      { books: 1, pages: 4, pageNotes: 0, boardNotes: 5 }
    )
    expect(clean.diverged).toBe(false)
    const dirty = buildDivergence(
      { books: 1, pages: 4, pageNotes: 0, boardNotes: 5 },
      { books: 1, pages: 5, pageNotes: 0, boardNotes: 5 }
    )
    expect(dirty.diverged).toBe(true)
    expect(dirty.tables.find((t) => t.table === 'pages')).toMatchObject({ tidb: 4, turso: 5, delta: -1 })
  })
})

describe('getStorageShiftStatus with operator override (no live probe)', () => {
  afterEach(() => {
    delete process.env.TIDB_BOOKS_REMAINING_BYTES
    delete process.env.TIDB_NOTES_REMAINING_BYTES
  })

  it('shifts books under 10MB and reports override source', () => {
    process.env.TIDB_BOOKS_REMAINING_BYTES = String(TIDB_LOW_STORAGE_THRESHOLD_BYTES - 1)
    process.env.TIDB_NOTES_REMAINING_BYTES = String(5 * 1024 * 1024 * 1024)
    const s = getStorageShiftStatus()
    expect(s.books.shiftedToTurso).toBe(true)
    expect(s.books.quotaSource).toBe('override')
    expect(s.notes.shiftedToTurso).toBe(false)
  })

  it('flags critical under 1MB', () => {
    process.env.TIDB_BOOKS_REMAINING_BYTES = '10'
    const s = getStorageShiftStatus()
    expect(s.isCritical1MB).toBe(true)
    expect(s.criticalAlertMessage).toBeTruthy()
  })
})
