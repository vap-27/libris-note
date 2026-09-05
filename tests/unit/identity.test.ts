import { describe, expect, it } from 'vitest'
import {
  normalizeName,
  normalizePin,
  isLeaseLive,
  suggestGuestName,
  HEARTBEAT_MS,
  LEASE_TTL_MS,
  SWEEP_MIN_AGE_MS,
} from '../../src/lib/identity'
import { hashPin, verifyPin, makeSalt } from '../../src/lib/identity-server'

describe('normalizeName', () => {
  it('accepts ordinary names, trims and collapses', () => {
    expect(normalizeName('  Maya  Rao ')).toBe('Maya Rao')
    expect(normalizeName('Jo')).toBe('Jo')
  })
  it('rejects blanks, single chars, non-strings', () => {
    expect(normalizeName('')).toBeNull()
    expect(normalizeName(' ')).toBeNull()
    expect(normalizeName('x')).toBeNull()
    expect(normalizeName(null)).toBeNull()
    expect(normalizeName(42)).toBeNull()
  })
  it('strips control chars and caps length', () => {
    expect(normalizeName('a\u0000b')).toBe('ab')
    expect(normalizeName('x'.repeat(100))!.length).toBeLessThanOrEqual(24)
  })
})

describe('normalizePin', () => {
  it('accepts 4–8 plain digits', () => {
    expect(normalizePin('1234')).toBe('1234')
    expect(normalizePin('12345678')).toBe('12345678')
    expect(normalizePin(9876)).toBe('9876')
  })
  it('rejects the rest', () => {
    expect(normalizePin('123')).toBeNull()
    expect(normalizePin('123456789')).toBeNull()
    expect(normalizePin('12 34')).toBeNull()
    expect(normalizePin('abcd')).toBeNull()
    expect(normalizePin('12ab')).toBeNull()
    expect(normalizePin(null)).toBeNull()
  })
})

describe('hashPin/verifyPin', () => {
  it('round-trips and rejects wrong PINs', () => {
    const salt = 'abc123'
    const h = hashPin('4242', salt)
    expect(verifyPin('4242', salt, h)).toBe(true)
    expect(verifyPin('4243', salt, h)).toBe(false)
    expect(verifyPin('4242', 'other', h)).toBe(false)
  })
  it('salt matters', () => {
    expect(hashPin('1111', 's1')).not.toBe(hashPin('1111', 's2'))
  })
  it('makeSalt is unique hex', () => {
    const a = makeSalt()
    const b = makeSalt()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('isLeaseLive', () => {
  it('true inside TTL, false outside or skewed', () => {
    expect(isLeaseLive(1000, 2000, 5000)).toBe(true)
    expect(isLeaseLive(1000, 7000, 5000)).toBe(false)
    expect(isLeaseLive(9000, 2000, 5000)).toBe(false) // future heartbeat = clock skew
    expect(isLeaseLive(NaN, 2000, 5000)).toBe(false)
  })
})

describe('timing constants sane', () => {
  it('heartbeat comfortably inside lease; sweep age generous', () => {
    expect(HEARTBEAT_MS).toBeLessThan(LEASE_TTL_MS / 2)
    expect(SWEEP_MIN_AGE_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('suggestGuestName', () => {
  it('produces Guest names', () => {
    expect(suggestGuestName(() => 0)).toMatch(/^Guest \w+ \w+$/)
  })
})
