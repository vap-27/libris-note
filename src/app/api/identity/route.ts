import { NextRequest, NextResponse } from 'next/server'
import { claimIdentity, verifyIdentity } from '@/lib/usrinfo'
import { requireAdmin } from '@/lib/auth'
import { rlDestructive } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/identity { action: 'claim'|'verify', name, pin }
 * Claim reserves a display name with a PIN so the same person gets it back
 * on a fresh browser (localStorage alone cannot survive a data clear).
 * A short PIN is continuity, not security — stated in-product, not just docs.
 */
export async function POST(req: NextRequest) {
  try {
    const gate = requireAdmin(req)
    if (gate) return gate
    // Strict bucket: PIN guessing gets 10 attempts/min/IP at most.
    const limited = await rlDestructive(req, 'identity')
    if (limited) return limited
    const body = await req.json().catch(() => ({}))
    const { action, name, pin } = body ?? {}

    if (action === 'claim') {
      try {
        const result = await claimIdentity(name, pin)
        return NextResponse.json({ ok: true, ...result })
      } catch (err: any) {
        const msg = String(err?.message || '')
        if (msg.startsWith('Name is taken')) {
          return NextResponse.json({ error: msg }, { status: 409 })
        }
        return NextResponse.json({ error: msg || 'Could not claim name' }, { status: 400 })
      }
    }

    if (action === 'verify') {
      try {
        const result = await verifyIdentity(name, pin)
        return NextResponse.json({ ok: true, ...result })
      } catch {
        // One generic message: never reveal whether the name exists.
        return NextResponse.json({ error: 'Unknown name or wrong PIN' }, { status: 401 })
      }
    }

    return NextResponse.json({ error: 'action must be claim or verify' }, { status: 400 })
  } catch (err) {
    console.error('[api/identity] POST failed:', err)
    return NextResponse.json({ error: 'Identity service unavailable' }, { status: 500 })
  }
}
