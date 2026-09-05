'use client'

import { useState } from 'react'
import { BookOpen, KeyRound, UserRound, X } from 'lucide-react'
import type { LocalIdentity } from '@/lib/identity-client'
import { saveIdentity } from '@/lib/identity-client'

interface IdentityGateProps {
  open: boolean
  guest: LocalIdentity
  onDone(identity: LocalIdentity): void
}

type Mode = 'choose' | 'claim' | 'verify'

/**
 * One-time identity onboarding (Wave 1). No login: pick how this browser
 * introduces itself. Claiming name+PIN is what survives a cleared browser —
 * said plainly in the copy, not buried in docs.
 */
export default function IdentityGate({ open, guest, onDone }: IdentityGateProps) {
  const [mode, setMode] = useState<Mode>('choose')
  // No prefilled guest name: the visitor types their own direct name.
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) return null

  const trimmed = name.trim()
  const nameOk = trimmed.length >= 2
  const pinOk = /^[0-9]{4,8}$/.test(pin)

  const submitClaim = async () => {
    if (!nameOk || !pinOk) {
      setError('Use at least 2 characters for the name and 4–8 digits for the PIN.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim', name: trimmed, pin }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Could not claim that name')
      const id: LocalIdentity = { clientId: guest.clientId, name: d.name, color: d.color, claimed: true }
      saveIdentity(id)
      onDone(id)
    } catch (e: any) {
      setError(e?.message || 'Could not claim that name')
    } finally {
      setBusy(false)
    }
  }

  const submitVerify = async () => {
    if (!nameOk || !pinOk) {
      setError('Enter your claimed name and its 4–8 digit PIN.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/identity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', name: trimmed, pin }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error || 'Unknown name or wrong PIN')
      const id: LocalIdentity = { clientId: guest.clientId, name: d.name, color: d.color, claimed: true }
      saveIdentity(id)
      onDone(id)
    } catch (e: any) {
      setError(e?.message || 'Unknown name or wrong PIN')
    } finally {
      setBusy(false)
    }
  }

  /** Continue with the typed name, unclaimed (session-only, no guest alias). */
  const continueDirect = () => {
    if (!nameOk) {
      setError('Type your name first (min 2 characters) — or claim one with a PIN.')
      return
    }
    const id: LocalIdentity = { clientId: guest.clientId, name: trimmed, color: guest.color, claimed: false }
    saveIdentity(id)
    onDone(id)
  }

  return (
    <div className="confirm-veil" role="dialog" aria-modal="true" aria-label="Who is writing?">
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-icon" aria-hidden="true">
          <BookOpen size={18} strokeWidth={2} />
        </div>
        {mode === 'choose' && (
          <>
            <h3 className="confirm-title">Who is writing today?</h3>
            <p className="confirm-body">
              Libris has no accounts. Pick how this browser introduces itself to
              other readers — shown beside your pages and notes.
            </p>
            <div className="confirm-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <input
                className="gate-input"
                value={name}
                maxLength={24}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name — type it directly"
                aria-label="Your name"
                autoFocus
              />
              <button type="button" className="confirm-remove" onClick={continueDirect}>
                <UserRound size={13} strokeWidth={2} aria-hidden="true" />
                Continue as {trimmed || '…'}
              </button>
              <button type="button" className="confirm-cancel" onClick={() => { setMode('claim'); setError(null) }}>
                <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
                Claim this name + PIN
              </button>
              <button
                type="button"
                className="confirm-cancel"
                onClick={() => { setMode('verify'); setError(null) }}
                style={{ border: 'none', background: 'transparent' }}
              >
                I already have a name + PIN
              </button>
              {error && (
                <p className="confirm-body" role="alert" style={{ color: '#e08080' }}>
                  {error}
                </p>
              )}
            </div>
          </>
        )}
        {mode !== 'choose' && (
          <>
            <h3 className="confirm-title">
              {mode === 'claim' ? 'Claim your ink-name' : 'Welcome back'}
            </h3>
            <p className="confirm-body">
              {mode === 'claim'
                ? 'A short PIN reserves the name. Re-enter both on any fresh browser to get it back — clearing browser data forgets everything else.'
                : 'Enter your name and PIN to pick up where you left off.'}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              <input
                className="gate-input"
                value={name}
                maxLength={24}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ink-name (min 2 characters)"
                aria-label="Ink-name"
                autoFocus
              />
              <input
                className="gate-input"
                value={pin}
                maxLength={8}
                inputMode="numeric"
                onChange={(e) => setPin(e.target.value)}
                placeholder="PIN — 4 to 8 digits"
                aria-label="PIN"
                type="password"
              />
              {error && (
                <p className="confirm-body" role="alert" style={{ color: '#e08080' }}>
                  {error}
                </p>
              )}
            </div>
            <div className="confirm-row">
              <button type="button" className="confirm-cancel" onClick={() => { setMode('choose'); setError(null) }}>
                <X size={13} strokeWidth={2} aria-hidden="true" />
                Back
              </button>
              <button
                type="button"
                className="confirm-remove"
                disabled={busy || !nameOk || !pinOk}
                onClick={mode === 'claim' ? submitClaim : submitVerify}
              >
                <KeyRound size={13} strokeWidth={2} aria-hidden="true" />
                {mode === 'claim' ? 'Claim it' : 'Verify me'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
