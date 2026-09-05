import { NextRequest, NextResponse } from 'next/server'

/**
 * Optional admin-token gate (C-1, H-2, H-3).
 *
 * - If `ADMIN_TOKEN` is NOT set, the app stays in legacy single-user open
 *   mode (localhost demo) so existing installs keep working.
 * - If `ADMIN_TOKEN` IS set, every mutating / sensitive route must present
 *   `Authorization: Bearer <token>`. Destructive routes (backup restore,
 *   log wipe) ALWAYS require it when configured.
 *
 * This gives a zero-breakage upgrade path: set ADMIN_TOKEN in production,
 * leave it empty for a private local demo.
 */

export function isAdminAuthConfigured(): boolean {
  return Boolean(process.env.ADMIN_TOKEN && process.env.ADMIN_TOKEN.length >= 16)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function isAdminRequest(req: NextRequest | Request): boolean {
  const token = process.env.ADMIN_TOKEN
  if (!token) return true // open mode (dev): nothing configured to check against
  const header =
    (req.headers.get('authorization') || req.headers.get('x-admin-token') || '').trim()
  if (!header) return false
  const presented = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header.trim()
  if (!presented) return false
  return timingSafeEqual(presented, token)
}

/**
 * Returns a 401 JSON response when admin auth is configured but missing/invalid.
 * Returns null when the request may proceed.
 */
export function requireAdmin(req: NextRequest | Request): NextResponse | null {
  if (!isAdminAuthConfigured()) return null
  if (isAdminRequest(req)) return null
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

/** Destructive ops (restore, log wipe) should call this: stricter messaging. */
export function requireAdminForDestructive(
  req: NextRequest | Request
): NextResponse | null {
  const res = requireAdmin(req)
  if (res) {
    return NextResponse.json(
      { error: 'Unauthorized: admin token required for this operation' },
      { status: 401 }
    )
  }
  return null
}
