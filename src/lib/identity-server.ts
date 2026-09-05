import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Server-only identity crypto (Wave 1). Imported by src/lib/turso.ts only —
 * NEVER from client components (node:crypto cannot ship to browsers).
 */

export function makeSalt(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}

/** SHA-256(salt + ':' + pin). Salts+hashes never leave the server. */
export function hashPin(pin: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${pin}`, 'utf8').digest('hex')
}

export function verifyPin(pin: string, salt: string, expectedHash: string): boolean {
  const a = Buffer.from(hashPin(pin, salt), 'hex')
  const b = Buffer.from(expectedHash, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
