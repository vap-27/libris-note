import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { checkSameOrigin } from '@/lib/csrf'

/**
 * Global CSRF gate (Wave A): every non-GET /api/* request carrying a
 * browser Origin/Referer must match the request Host. GETs pass through
 * (reads change no state); headerless clients (curl, jobs) pass through.
 */
export function middleware(req: NextRequest) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return NextResponse.next()
  }
  return checkSameOrigin(req) ?? NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
