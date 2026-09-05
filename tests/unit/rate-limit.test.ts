import { describe, expect, it } from 'vitest'
import {
  checkRateLimit,
  getIdempotentReplay,
  setIdempotentReplay,
  hashBody,
} from '../../src/lib/rate-limit'

const req = (ip?: string) =>
  new Request('http://localhost:3000/api/pages', ip ? { headers: { 'x-real-ip': ip } } : undefined) as any

describe('hashBody', () => {
  it('is deterministic and distinguishes bodies', () => {
    expect(hashBody({ a: 1 })).toBe(hashBody({ a: 1 }))
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }))
    expect(hashBody('x')).toBe(hashBody('x'))
  })
})

describe('checkRateLimit (memory backend)', () => {
  it('allows under budget and 429s over with Retry-After', async () => {
    const bucket = `t-allow-${Date.now()}`
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(req(), { limit: 3, windowMs: 60_000, bucket })).toBeNull()
    }
    const blocked = await checkRateLimit(req(), { limit: 3, windowMs: 60_000, bucket })
    expect(blocked).not.toBeNull()
    expect(blocked!.status).toBe(429)
    expect(blocked!.headers.get('Retry-After')).toBeTruthy()
  })

  it('isolates buckets per client ip', async () => {
    const bucket = `t-iso-${Date.now()}`
    expect(await checkRateLimit(req('1.2.3.4'), { limit: 1, windowMs: 60_000, bucket })).toBeNull()
    expect(await checkRateLimit(req('1.2.3.4'), { limit: 1, windowMs: 60_000, bucket })).not.toBeNull()
    expect(await checkRateLimit(req('5.6.7.8'), { limit: 1, windowMs: 60_000, bucket })).toBeNull()
  })
})

describe('idempotency replay binding', () => {
  it('replays same key + same body, misses on different body', () => {
    const key = `tkey-${Date.now()}-${Math.random()}`
    const body = { bookId: 'b', after: 1 }
    expect(getIdempotentReplay(key, hashBody(body))).toBeNull()
    setIdempotentReplay(key, 201, { page: 1 }, hashBody(body))
    expect(getIdempotentReplay(key, hashBody(body))).toEqual({ status: 201, body: { page: 1 } })
    expect(getIdempotentReplay(key, hashBody({ bookId: 'b', after: 2 }))).toBeNull()
  })

  it('ignores short keys', () => {
    setIdempotentReplay('short', 201, {}, 'h')
    expect(getIdempotentReplay('short', 'h')).toBeNull()
  })
})
