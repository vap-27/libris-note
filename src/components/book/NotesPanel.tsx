'use client'

import { useEffect, useRef, useState } from 'react'
import { NotebookPen, Plus, Trash2, X, Check, Pencil, Loader2, Undo2, RotateCcw, ZoomIn } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import type { PageData, PageNoteData } from '@/lib/types'
import { NOTE_COLORS } from '@/lib/types'
import { relativeTime } from '@/lib/anim'

interface NotesPanelProps {
  open: boolean
  page: PageData | null
  /** Reading zoom is on: the panel becomes read-only until it is turned off. */
  readOnly?: boolean
  onClose(): void
  onNotesChanged(pageNumber: number): void
}

const COLOR_DOT: Record<string, string> = {
  amber: '#e9b44c',
  rose: '#d98a83',
  sage: '#8fae8b',
  sky: '#86a8c0',
  lilac: '#a291c9',
  butter: '#dbb95a',
}

export default function NotesPanel({ open, page, readOnly, onClose, onNotesChanged }: NotesPanelProps) {
  const { toast } = useToast()
  const [notes, setNotes] = useState<PageNoteData[]>([])
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftColor, setDraftColor] = useState<string>('amber')
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const editRef = useRef<HTMLTextAreaElement>(null)
  // Last failed note intent, for idempotency-key reuse on immediate retry.
  const failKey = useRef<{ key: string; body: string; at: number } | null>(null)

  const newIdemKey = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`

  const pageNumber = page?.pageNumber ?? 0

  useEffect(() => {
    if (!open || !page) return
    let cancelled = false
    // Kicked off one tick later so the effect body never setStates
    // synchronously; loader timing is unchanged (a tick is invisible).
    const t = setTimeout(() => {
      setLoading(true)
      fetch(`/api/pages/${page.id}/notes`)
        .then((r) => (r.ok ? r.json() : { notes: [] }))
        .then((d) => {
          if (!cancelled) setNotes(d.notes ?? [])
        })
        .catch(() => {
          if (!cancelled) setNotes([])
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // keyed on the page's id, not its object identity — an autosave of the
    // open page must not flash the loader over the list
  }, [open, page?.id])

  useEffect(() => {
    if (editingId) {
      const t = setTimeout(() => editRef.current?.focus(), 60)
      return () => clearTimeout(t)
    }
  }, [editingId])

  const addNote = async () => {
    const content = draft.trim()
    if (!content || !page || saving || readOnly) return
    setSaving(true)
    // Reuse the key when retrying the same unsent draft within 10s so the
    // server replays instead of minting a twin.
    const bodySig = `${page.id}|${draftColor}|${content}`
    const kept = failKey.current
    const idemKey =
      kept && Date.now() - kept.at < 10_000 && kept.body === bodySig ? kept.key : newIdemKey()
    try {
      const res = await fetch(`/api/pages/${page.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': idemKey },
        body: JSON.stringify({ content, color: draftColor }),
      })
      if (res.ok) {
        failKey.current = null
        const { note } = await res.json()
        setNotes((n) => [...n, note])
        setDraft('')
        onNotesChanged(pageNumber)
        toast({
          title: 'Margin Note Created',
          description: `Attached to page ${pageNumber} and saved to database.`,
          className: 'toast-ink',
        })
      } else {
        failKey.current = { key: idemKey, body: bodySig, at: Date.now() }
      }
    } catch {
      failKey.current = { key: idemKey, body: bodySig, at: Date.now() }
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = async (id: string) => {
    const content = editDraft.trim()
    if (!content) return
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
    if (res.ok) {
      const { note } = await res.json()
      setNotes((n) => n.map((x) => (x.id === id ? note : x)))
      onNotesChanged(pageNumber)
      toast({
        title: 'Margin Note Saved',
        description: 'Updated in database.',
        className: 'toast-ink',
      })
    }
    setEditingId(null)
  }

  const deleteNote = async (id: string) => {
    const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' })
    if (res.ok) {
      setNotes((n) => n.filter((x) => x.id !== id))
      onNotesChanged(pageNumber)
      toast({
        title: 'Note moved to trash',
        description: 'You can put it back on the page.',
        className: 'toast-ink',
        action: (
          <ToastAction
            altText="Undo the deletion"
            className="undo-btn"
            onClick={() => restoreNote(id)}
          >
            <Undo2 size={13} strokeWidth={2} aria-hidden="true" />
            Undo
          </ToastAction>
        ),
      })
    }
  }

  /** Reverts the deletion: the stored note returns exactly as it was. */
  const restoreNote = async (id: string) => {
    const res = await fetch(`/api/notes/${id}/restore`, { method: 'POST' })
    if (res.ok) {
      const { note } = await res.json()
      setNotes((n) => [...n, note])
      onNotesChanged(pageNumber)
      toast({
        title: 'Margin Note Restored',
        description: `Returned to page ${pageNumber}.`,
        className: 'toast-ink',
      })
    }
  }

  return (
    <aside className={`notes-panel ${open ? 'notes-panel--open' : ''}`} aria-hidden={!open}>
      <header className="notes-panel-head">
        <span className="notes-panel-title">
          <NotebookPen size={17} strokeWidth={1.8} aria-hidden="true" />
          Margin notes
        </span>
        <div className="notes-panel-head-right">
          {readOnly && (
            <span className="notes-ro-chip" title="Turn zoom off to write">
              <ZoomIn size={12} strokeWidth={2} aria-hidden="true" />
              Reading zoom on
            </span>
          )}
          <button type="button" className="notes-panel-close" onClick={onClose} aria-label="Close notes panel">
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      </header>

      {page ? (
        <div className="notes-panel-page">
          <span className="notes-panel-page-kicker">Page {page.pageNumber} · {page.section}</span>
          <span className="notes-panel-page-title">{page.title}</span>
        </div>
      ) : (
        <div className="notes-panel-page">
          <span className="notes-panel-page-title">No page selected</span>
        </div>
      )}

      <div className="notes-list" role="list">
        {loading ? (
          <div className="notes-loading"><Loader2 className="spin" size={18} strokeWidth={2} /> Loading notes…</div>
        ) : notes.length === 0 ? (
          <div className="notes-empty">
            No notes on this page yet. Write your first one below — it is saved to the notes database instantly.
          </div>
        ) : (
          notes.map((n) => (
            <div key={n.id} className={`note-slip note-slip--${n.color}`} role="listitem">
              <div className="note-slip-top">
                <span className="note-slip-date">{relativeTime(n.createdAt)}</span>
                <span className="note-slip-actions">
                  <button
                    type="button"
                    aria-label="Edit note"
                    disabled={readOnly}
                    onClick={() => {
                      if (readOnly) return
                      setEditingId(n.id)
                      setEditDraft(n.content)
                    }}
                  >
                    <Pencil size={13} strokeWidth={1.8} />
                  </button>
                  <button type="button" aria-label="Delete note" disabled={readOnly} onClick={() => { if (!readOnly) deleteNote(n.id) }}>
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </span>
              </div>
              {editingId === n.id ? (
                <div className="note-slip-edit">
                  <textarea
                    ref={editRef}
                    value={editDraft}
                    rows={3}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(n.id)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                  />
                  <div className="note-slip-edit-actions">
                    <button type="button" className="btn-mini btn-mini--ghost" onClick={() => setEditingId(null)} aria-label="Revert to saved note" title="Revert to saved">
                      <RotateCcw size={13} strokeWidth={2} />
                    </button>
                    <button type="button" className="btn-mini btn-mini--save" onClick={() => saveEdit(n.id)} aria-label="Save note" title="Save (Ctrl+Enter)">
                      <Check size={13} strokeWidth={2.2} />
                    </button>
                  </div>
                </div>
              ) : (
                <p className="note-slip-content">{n.content}</p>
              )}
            </div>
          ))
        )}
      </div>

      <div className="notes-compose">
        {readOnly ? (
          <div className="notes-compose-ro">
            <ZoomIn size={14} strokeWidth={1.8} aria-hidden="true" />
            Reading zoom is on. Pages are read-only — turn zoom off to write on this page.
          </div>
        ) : (
          <>
            <textarea
              value={draft}
              rows={2}
              placeholder={`Note on page ${pageNumber}…`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote()
              }}
            />
            <div className="notes-compose-row">
              <div className="color-dots" role="radiogroup" aria-label="Note color">
                {NOTE_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={draftColor === c}
                    aria-label={c}
                    className={`color-dot ${draftColor === c ? 'color-dot--on' : ''}`}
                    style={{ background: COLOR_DOT[c] }}
                    onClick={() => setDraftColor(c)}
                  />
                ))}
              </div>
              <button
                type="button"
                className="notes-add"
                onClick={addNote}
                disabled={!draft.trim() || saving}
              >
                {saving ? <Loader2 className="spin" size={14} strokeWidth={2} /> : <Plus size={14} strokeWidth={2.2} />}
                Pin note
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
