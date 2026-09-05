'use client'

import { suggestGuestName, PRESENCE_COLORS } from './identity'

/**
 * Browser identity store (Wave 1). localStorage persists across visits;
 * a full browser-data clear wipes it — that is exactly what the optional
 * name+PIN claim (POST /api/identity) exists to recover from.
 */

export interface LocalIdentity {
  clientId: string
  name: string
  color: string
  claimed: boolean
}

const KEY = 'libris_identity'

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function colorForClientId(clientId: string): string {
  let h = 0
  for (let i = 0; i < clientId.length; i++) h = (h * 31 + clientId.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]
}

export function loadIdentity(): LocalIdentity | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const d = JSON.parse(raw) as Partial<LocalIdentity>
    if (!d || typeof d.clientId !== 'string' || !d.clientId) return null
    return {
      clientId: d.clientId,
      name: typeof d.name === 'string' && d.name ? d.name : suggestGuestName(),
      color:
        typeof d.color === 'string' && PRESENCE_COLORS.includes(d.color)
          ? d.color
          : colorForClientId(d.clientId),
      claimed: d.claimed === true,
    }
  } catch {
    return null
  }
}

export function saveIdentity(id: LocalIdentity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(id))
  } catch {}
}

export function freshGuestIdentity(): LocalIdentity {
  const clientId = uuid()
  return { clientId, name: suggestGuestName(), color: colorForClientId(clientId), claimed: false }
}

/** Per-tab id: same browser shares locks (clientId), tabs stay distinguishable. */
export function getTabId(): string {
  try {
    let t = sessionStorage.getItem('libris_tab')
    if (!t) {
      t = uuid()
      sessionStorage.setItem('libris_tab', t)
    }
    return t
  } catch {
    return uuid()
  }
}
