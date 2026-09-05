import { NextRequest, NextResponse } from 'next/server'

/**
 * Drive-by CSRF gate for mutating routes (Wave A).
 *
 * Browsers attach Origin (fetch/XHR) or Referer (top-level form navigation)
 * to cross-site requests; non-browser clients (curl, mobile apps, server jobs)
 * send neither. Policy: if a claimed origin is present it MUST match the
 * request Host, otherwise 403. Missing header = allow (curl can't be blocked
 * anyway, and blocking it would break legitimate API clients).
 *
 * Uses the direct Host header (never X-Forwarded-Host, which is spoofable).
 */
export function checkSameOrigin(req: NextRequest | Request): NextResponse | null {
  const origin = req.headers.get('origin')
  const referer = req.headers.get('referer')
  const claimed = (origin || referer || '').trim()
  if (!claimed) return null

  let claimedHost: string
  try {
    claimedHost = new URL(claimed).host.toLowerCase()
  } catch {
    return NextResponse.json({ error: 'Bad origin' }, { status: 403 })
  }
  if (!claimedHost) return null

  const host = (req.headers.get('host') || '').split(',')[0].trim().toLowerCase()
  if (!host) return null
  if (claimedHost !== host) {
    return NextResponse.json({ error: 'Cross-origin request refused' }, { status: 403 })
  }
  return null
}
