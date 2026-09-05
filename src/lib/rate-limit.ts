import { NextRequest, NextResponse } from 'next/server'

/**
 * Rate limiter (M-3, M-5).
 *
 * Two backends, chosen at runtime:
 *  - Upstash Redis (REST) when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *    are set → shared counters across Vercel/serverless instances.
 *  - In-memory sliding window otherwise → single-instance/local dev.
 *
 * All checks are async. On Redis errors we fail OPEN into the memory limiter
 * so a Redis blip can never take the app down (documented trade-off).
 */

type Bucket = { count: number; resetAt: number }

const globalForRl = globalThis as unknown as {
  __librisRl?: Map<string, Bucket>
  __librisIdem?: Map<string, { status: number; body: unknown; hash: string; expiresAt: number }>
}

const buckets = globalForRl.__librisRl ?? new Map<string, Bucket>()
globalForRl.__librisRl = buckets

const idemCache =
  globalForRl.__librisIdem ??
  new Map<string, { status: number; body: unknown; hash: string; expiresAt: number }>()
globalForRl.__librisIdem = idemCache

function clientIp(req: NextRequest | Request): string {
  const h = (name: string) => req.headers.get(name) || ''
  // Wave E: prefer x-real-ip (Caddy sets it from the connection remote_host;
  // Vercel sets it to the true client). x-forwarded-for is only a fallback:
  // its entries are sender-controlled on direct-origin traffic, so IP limits
  // are advisory there by nature.
  const ip =
    h('x-real-ip').trim() ||
    h('x-forwarded-for').split(',')[0].trim() ||
    'local'
  return (ip || 'local').replace(/[^a-zA-Z0-9.:_-]/g, '').slice(0, 64) || 'local'
}

export interface RateLimitOpts {
  /** max requests per window */
  limit: number
  /** window in ms */
  windowMs: number
  /** bucket suffix so reads/writes/destructive have separate budgets */
  bucket?: string
  /**
   * Fail closed when the Redis backend is configured but unreachable.
   * Used for destructive budgets only: brief 503s beat unbounded
   * wipe/restore during an outage. Reads/writes stay fail-open.
   */
  failClosed?: boolean
}

const DEFAULT_WINDOW = 60_000

function memoryCheck(key: string, opts: RateLimitOpts): NextResponse | null {
  const now = Date.now()
  const windowMs = opts.windowMs || DEFAULT_WINDOW

  // opportunistic cleanup (1% of calls)
  if (Math.random() < 0.01) {
    for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k)
    for (const [k, v] of idemCache) if (v.expiresAt < now) idemCache.delete(k)
  }

  const cur = buckets.get(key)
  if (!cur || cur.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return null
  }
  cur.count += 1
  if (cur.count > opts.limit) {
    const retryAfter = Math.max(1, Math.ceil((cur.resetAt - now) / 1000))
    return NextResponse.json(
      { error: 'Too many requests, slow down' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    )
  }
  return null
}

function redisConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
}

/** Fixed-window INCR via Upstash REST pipeline. Returns count or null on error. */
async function redisIncr(key: string, windowSec: number): Promise<number | null> {
  try {
    const url = `${process.env.UPSTASH_REDIS_REST_URL}/pipeline`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', key],
        ['EXPIRE', key, String(windowSec), 'NX'],
      ]),
      signal: AbortSignal.timeout(1500),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Array<{ result: unknown }>
    const count = Number(data?.[0]?.result)
    return Number.isFinite(count) ? count : null
  } catch {
    return null
  }
}

export async function checkRateLimit(
  req: NextRequest | Request,
  opts: RateLimitOpts
): Promise<NextResponse | null> {
  const bucket = opts.bucket || 'default'
  const key = `libris:rl:${bucket}:${clientIp(req)}`
  const windowMs = opts.windowMs || DEFAULT_WINDOW

  if (redisConfigured()) {
    const count = await redisIncr(key, Math.max(1, Math.round(windowMs / 1000)))
    if (count == null) {
      if (opts.failClosed) {
        return NextResponse.json(
          { error: 'Rate limiter unavailable, try again shortly' },
          { status: 503, headers: { 'Retry-After': '5' } }
        )
      }
      // Reads/writes fail open into the memory limiter (availability first).
      return memoryCheck(key, opts)
    }
    if (count > opts.limit) {
      return NextResponse.json(
        { error: 'Too many requests, slow down' },
        { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.round(windowMs / 1000))) } }
      )
    }
    return null
  }

  return memoryCheck(key, opts)
}

/** Presets: reads are cheap, writes stricter, destructive strictest. */
export const rlRead = (req: NextRequest | Request, bucket = 'read') =>
  checkRateLimit(req, { limit: 120, windowMs: 60_000, bucket })
export const rlWrite = (req: NextRequest | Request, bucket = 'write') =>
  checkRateLimit(req, { limit: 60, windowMs: 60_000, bucket })
export const rlDestructive = (req: NextRequest | Request, bucket = 'destructive') =>
  checkRateLimit(req, { limit: 10, windowMs: 60_000, bucket, failClosed: true })

/** FNV-1a hex: binds an idempotency key to its request body (Wave D, M14). */
export function hashBody(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Idempotency for POST create (M-5): client may send `x-idempotency-key`.
 * Server caches the response for 10 min and replays it for retries.
 * The key is BOUND to the body hash: same key + different body = miss
 * (processes as new), so a stale key can never return the wrong resource.
 * NOTE: in-memory only (single-instance). Multi-instance duplicate-key replay
 * across instances is not guaranteed — the server-side unique-retry in
 * POST /api/pages is the backstop for that case.
 */
export function getIdempotentReplay(
  key: string | null,
  bodyHash?: string
): { status: number; body: unknown } | null {
  if (!key) return null
  const hit = idemCache.get(`idem:${key}`)
  if (!hit) return null
  if (hit.expiresAt < Date.now()) {
    idemCache.delete(`idem:${key}`)
    return null
  }
  if (bodyHash && hit.hash !== bodyHash) return null
  return { status: hit.status, body: hit.body }
}

export function setIdempotentReplay(
  key: string | null,
  status: number,
  body: unknown,
  bodyHash?: string
) {
  if (!key) return
  if (key.length < 8 || key.length > 128) return
  idemCache.set(`idem:${key}`, {
    status,
    body,
    hash: bodyHash ?? '',
    expiresAt: Date.now() + 10 * 60_000,
  })
}
