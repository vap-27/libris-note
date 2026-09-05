/**
 * Identity without login (Wave 1+). BROWSER-SAFE: this module must never
 * import node built-ins — it ships to the client (gate, pill, hooks).
 * Server-only crypto lives in ./identity-server.
 *
 * - Every browser gets an auto identity: stable clientId (localStorage) +
 *   display name. Zero friction, dies with cleared storage (by design).
 * - Optional claim: name + 4–8 digit PIN, verified server-side. This is what
 *   survives a cleared browser or a new device — the user re-enters both.
 * - Honest limitation: a short PIN is continuity, not security. Anyone who
 *   guesses name+PIN can wear the name. Rate-limited claim attempts bound
 *   the guessing. Never use this for authorization — only for display names
 *   and advisory edit locks.
 */

export const IDENTITY_NAME_MAX = 24
export const IDENTITY_PIN_MIN = 4
export const IDENTITY_PIN_MAX = 8

const GUEST_ADJECTIVES = ['Amber', 'Birch', 'Cinder', 'Dune', 'Ember', 'Fern', 'Grove', 'Harbor']
const GUEST_NOUNS = ['Fox', 'Wren', 'Otter', 'Mole', 'Heron', 'Newt', 'Finch', 'Badger']

export const PRESENCE_COLORS = [
  '#d9a93f',
  '#7fb069',
  '#e07a9a',
  '#6aa5d8',
  '#a78bda',
  '#e08a4e',
  '#4db6ac',
  '#94a3b8',
]

export function suggestGuestName(random = Math.random): string {
  const a = GUEST_ADJECTIVES[Math.floor(random() * GUEST_ADJECTIVES.length)]
  const b = GUEST_NOUNS[Math.floor(random() * GUEST_NOUNS.length)]
  return `Guest ${a} ${b}`
}

/** Normalize a display name: trim, collapse spaces, strip controls, cap. */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const clean = raw
    .replace(/[^\S ]+/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, IDENTITY_NAME_MAX)
  return clean.length >= 2 ? clean : null
}

/** PIN: plain 4–8 digits, nothing else. Returns canonical form or null. */
export function normalizePin(raw: unknown): string | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d+$/.test(s)) return null
  if (s.length < IDENTITY_PIN_MIN || s.length > IDENTITY_PIN_MAX) return null
  return s
}

/** Lease liveness: heartbeat/updatedAt within ttl of now (all ms). */
export function isLeaseLive(updatedAtMs: number, nowMs: number, ttlMs: number): boolean {
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs) || ttlMs <= 0) return false
  const age = nowMs - updatedAtMs
  return age >= 0 && age < ttlMs
}

export const HEARTBEAT_MS = 10_000
export const LEASE_TTL_MS = 25_000
export const IDLE_EDIT_MS = 120_000
export const SWEEP_MIN_AGE_MS = 90_000
