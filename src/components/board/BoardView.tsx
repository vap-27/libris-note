'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, StickyNote, FileText, Trash2, RotateCcw, Check, X, GripVertical,
  Loader2, Pin, Undo2, ZoomIn, ZoomOut, BookPlus, Maximize2, Minimize2, Crosshair,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { ToastAction } from '@/components/ui/toast'
import type { BoardNoteData } from '@/lib/types'
import { NOTE_COLORS } from '@/lib/types'
import { relativeTime, clamp } from '@/lib/anim'

interface BoardViewProps {
  open: boolean
  onClose(): void
  /** the board can write pages into the book — tell the app to refetch */
  onPagesChanged?(): void
}

const COLOR_HEX: Record<string, string> = {
  amber: '#f2cf6b',
  rose: '#f0b8b1',
  sage: '#c4d8b8',
  sky: '#b8d2e6',
  lilac: '#cfc3e8',
  butter: '#f6e7ac',
}

/** Magnification of the notes layer while board zoom is on. */
const BOARD_ZOOM = 1.55

/** pointer travel before a press becomes a drag (clicks stay clicks) */
const DRAG_THRESHOLD = 7

type Mode =
  | { kind: 'idle' }
  | { kind: 'drag'; id: string; startX: number; startY: number; origX: number; origY: number }
  | { kind: 'resize'; id: string; startX: number; startY: number; origW: number; origH: number }

/** A press on a note that has not yet decided between click and drag. */
interface Press {
  id: string
  startX: number
  startY: number
  moved: boolean
  /** where the press landed — decides what a click does */
  onContent: boolean
  onHandle: boolean
}

function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key: string): string {
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  if (key === todayKey) return 'Today'
  const d = new Date(`${key}T12:00:00`)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d)
}

export default function BoardView({ open, onClose, onPagesChanged }: BoardViewProps) {
  const { toast } = useToast()
  const [notes, setNotes] = useState<BoardNoteData[]>([])
  const [trash, setTrash] = useState<BoardNoteData[]>([])
  const [showTrash, setShowTrash] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadStage, setLoadStage] = useState<'reading' | 'arranged'>('reading')
  const [loadInfo, setLoadInfo] = useState<{ notes: number; days: number } | null>(null)
  const [closing, setClosing] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [newColor, setNewColor] = useState<string>('amber')
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  // reading zoom: notes are magnified + pannable, and strictly read-only
  const [zoom, setZoom] = useState(false)
  // full-bleed board (expand)
  const [expanded, setExpanded] = useState(false)
  // day filter from the timeline rail
  const [dayFilter, setDayFilter] = useState<string | null>(null)
  // true once the board has been panned away from its home position
  const [panned, setPanned] = useState(false)
  const [sendingId, setSendingId] = useState<string | null>(null)
  const [rattleId, setRattleId] = useState<string | null>(null)
  const [draftModal, setDraftModal] = useState<{
    open: boolean
    content: string
    color: string
    type: 'sticky' | 'card'
  }>({
    open: false,
    content: '',
    color: 'amber',
    type: 'sticky',
  })

  const boardRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const topZ = useRef(10)
  const pan = useRef({ x: 0, y: 0 })
  const panDrag = useRef({ active: false, lastX: 0, lastY: 0 })
  const press = useRef<Press | null>(null)
  const zoomRef = useRef(false)
  useEffect(() => { zoomRef.current = zoom }, [zoom])

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev
      if (typeof document !== 'undefined') {
        if (next) {
          if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {})
          }
        } else {
          if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {})
          }
        }
      }
      return next
    })
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const onFs = () => {
      if (!document.fullscreenElement) {
        setExpanded(false)
      }
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  // ----- the day slider -----
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const flagRef = useRef<HTMLSpanElement>(null)
  /** slot the drag is currently resting on (0 = all days) */
  const lastSlot = useRef(0)
  /** day keys, kept in a ref so window pointer handlers never see stale state */
  const dayKeysRef = useRef<string[]>([])
  /** days already laid on the slider — a day arriving later pulses */
  const seenDays = useRef<Set<string>>(new Set())
  const [pulseDay, setPulseDay] = useState<string | null>(null)
  /** notes snapshot for stable callbacks (mirrored in an effect, never during render) */
  const notesRef = useRef<BoardNoteData[]>([])
  useEffect(() => {
    notesRef.current = notes
  }, [notes])
  /** one note creation in flight at a time */
  const addingRef = useRef(false)
  /** last failed board-note intent, for idempotency-key reuse on retry */
  const draftFailKey = useRef<{ key: string; body: string; at: number } | null>(null)

  // ----- load live + trashed notes whenever the board opens -----
  // The loader tells the truth: it reads both the live list and the trash
  // from the notes cluster, reports the real counts, and only then lays the
  // notes out exactly where they were left. (The component remounts on every
  // open, so loading starts as 'reading' by construction.)
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const t0 = performance.now()
    Promise.all([
      fetch('/api/board').then((r) => (r.ok ? r.json() : { notes: [] })),
      fetch('/api/board?trash=1').then((r) => (r.ok ? r.json() : { notes: [] })),
    ])
      .then(([live, trashed]) => {
        if (cancelled) return
        const liveNotes: BoardNoteData[] = live.notes ?? []
        setNotes(liveNotes)
        setTrash(trashed.notes ?? [])
        topZ.current = Math.max(10, ...liveNotes.map((n) => n.z))
        const days = new Set(liveNotes.map((n) => localDayKey(n.createdAt))).size
        setLoadInfo({ notes: liveNotes.length, days })
        setLoadStage('arranged')
        const elapsed = performance.now() - t0
        const wait = Math.max(0, 640 - elapsed)
        setTimeout(() => { if (!cancelled) setLoading(false) }, wait)
      })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  // ----- graceful exit: unmount after the fade-out runs -----
  const requestClose = useCallback(() => {
    setClosing(true)
    setTimeout(() => {
      setClosing(false)
      onClose()
    }, 200)
  }, [onClose])

  useEffect(() => {
    if (editingId) {
      const t = setTimeout(() => editRef.current?.focus(), 80)
      return () => clearTimeout(t)
    }
  }, [editingId])

  useEffect(() => {
    if (open) {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return
        // Escape peels one layer at a time: editor → day filter → board
        if (editingId) {
          setEditingId(null)
          return
        }
        if (dayFilter) {
          setDayFilter(null)
          return
        }
        requestClose()
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
  }, [open, requestClose, editingId, dayFilter])

  // ----- zoom layer transform (pan is imperative; zoom animates) -----
  const applyLayer = useCallback((animate: boolean) => {
    const el = layerRef.current
    if (!el) return
    el.style.transition = animate ? 'transform 480ms cubic-bezier(0.77, 0, 0.175, 1)' : 'none'
    el.style.transform = `translate(${pan.current.x.toFixed(1)}px, ${pan.current.y.toFixed(1)}px) scale(${zoomRef.current ? BOARD_ZOOM : 1})`
    setPanned(Math.abs(pan.current.x) > 2 || Math.abs(pan.current.y) > 2)
  }, [])

  const toggleZoom = useCallback(() => {
    const next = !zoomRef.current
    zoomRef.current = next
    if (!next) pan.current = { x: 0, y: 0 }
    if (next) setEditingId(null) // read-only: no writing while magnified
    setZoom(next)
    requestAnimationFrame(() => applyLayer(true))
  }, [applyLayer])

  /** pan limits keep the reader from sliding into pure emptiness */
  const panBounds = () => {
    const b = boardRef.current
    const bw = b?.clientWidth ?? 800
    const bh = b?.clientHeight ?? 600
    const maxX = Math.max(0, (bw * (BOARD_ZOOM - 1)) / 2 + 80) + 700
    const maxY = Math.max(0, (bh * (BOARD_ZOOM - 1)) / 2 + 80) + 520
    return { maxX, maxY }
  }

  /** glide the layer so a point (in note coordinates) sits at the viewport centre */
  const centerOn = useCallback((cx: number, cy: number, animate = true) => {
    const b = boardRef.current
    const el = layerRef.current
    if (!b || !el) return
    const bw = b.clientWidth
    const bh = b.clientHeight
    const s = zoomRef.current ? BOARD_ZOOM : 1
    // transform-origin of the notes layer
    const ox = bw * 0.5
    const oy = bh * 0.38
    const rect = el.getBoundingClientRect()
    const scaleNow = rect.width / Math.max(1, bw)
    void scaleNow
    pan.current = {
      x: bw / 2 - ox - (cx - ox) * s,
      y: bh / 2 - oy - (cy - oy) * s,
    }
    const { maxX, maxY } = panBounds()
    pan.current.x = Math.max(-maxX, Math.min(maxX, pan.current.x))
    pan.current.y = Math.max(-maxY, Math.min(maxY, pan.current.y))
    applyLayer(animate)
  }, [applyLayer])

  /** the day slider: slide through the days the board was written on.
   *  Slot 0 is All; slot i is day i-1. Notes written on other days leave
   *  the felt as the thumb passes, and return when it slides back. */
  const applySlot = useCallback((slot: number, glide = false) => {
    const N = dayKeysRef.current.length
    const s = clamp(slot, 0, N)
    if (s <= 0) {
      setDayFilter(null)
      if (glide) {
        pan.current = { x: 0, y: 0 }
        applyLayer(true)
      }
    } else {
      const key = dayKeysRef.current[s - 1]
      if (key) {
        setDayFilter(key)
        if (glide) {
          const group = notesRef.current.filter((n) => localDayKey(n.createdAt) === key)
          if (group.length > 0) {
            const minX = Math.min(...group.map((n) => n.x))
            const maxX = Math.max(...group.map((n) => n.x + n.width))
            const minY = Math.min(...group.map((n) => n.y))
            const maxY = Math.max(...group.map((n) => n.y + n.height))
            centerOn((minX + maxX) / 2, (minY + maxY) / 2)
          }
        }
      }
    }
    const pct = `${(s / Math.max(1, N)) * 100}%`
    if (thumbRef.current) thumbRef.current.style.left = pct
    if (flagRef.current) flagRef.current.style.left = pct
    lastSlot.current = s
  }, [applyLayer, centerOn])

  /** commit from a tick press or the keyboard */
  const commitDay = useCallback((key: string | null) => {
    if (key === null) {
      applySlot(0, true)
      return
    }
    const idx = dayKeysRef.current.indexOf(key)
    applySlot(idx + 1, true)
  }, [applySlot])

  const slotOfClientX = (clientX: number): number => {
    const track = trackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const pct = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1)
    return Math.round(pct * dayKeysRef.current.length)
  }

  /** drag the thumb: the filter follows the thumb live, then the release
   *  snaps and glides the felt to the chosen day */
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (zoom || loading) return
    e.preventDefault()
    const startSlot = slotOfClientX(e.clientX)
    applySlot(startSlot)
    const onMove = (ev: PointerEvent) => {
      const track = trackRef.current
      const thumb = thumbRef.current
      if (track && thumb) {
        const rect = track.getBoundingClientRect()
        const pct = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1)
        thumb.style.left = `${pct * 100}%`
        if (flagRef.current) flagRef.current.style.left = `${pct * 100}%`
      }
      const s = slotOfClientX(ev.clientX)
      if (s !== lastSlot.current) applySlot(s)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      applySlot(lastSlot.current, true)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onTrackKeyDown = (e: React.KeyboardEvent) => {
    if (zoom) return
    const N = dayKeysRef.current.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      applySlot(clamp(lastSlot.current + 1, 0, N), true)
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      applySlot(clamp(lastSlot.current - 1, 0, N), true)
    } else if (e.key === 'Home') {
      e.preventDefault()
      applySlot(0, true)
    } else if (e.key === 'End') {
      e.preventDefault()
      applySlot(N, true)
    }
  }

  const goHome = useCallback(() => {
    applySlot(0, true)
  }, [applySlot])

  // pan the layer by dragging the empty felt (works zoomed or not)
  const onSurfacePointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.board-note, .board-timeline, button')) return
    panDrag.current = { active: true, lastX: e.clientX, lastY: e.clientY }

    const onMove = (ev: PointerEvent) => {
      if (!panDrag.current.active) return
      pan.current.x += (ev.clientX - panDrag.current.lastX)
      pan.current.y += (ev.clientY - panDrag.current.lastY)
      panDrag.current.lastX = ev.clientX
      panDrag.current.lastY = ev.clientY
      const { maxX, maxY } = panBounds()
      pan.current.x = Math.max(-maxX, Math.min(maxX, pan.current.x))
      pan.current.y = Math.max(-maxY, Math.min(maxY, pan.current.y))
      applyLayer(false)
    }
    const onUp = () => {
      panDrag.current.active = false
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  // ----- global pointer handlers for drag / resize -----
  useEffect(() => {
    if (mode.kind === 'idle') return

    const onMove = (e: PointerEvent) => {
      const m = mode
      if (m.kind === 'drag') {
        const nx = m.origX + (e.clientX - m.startX)
        const ny = m.origY + (e.clientY - m.startY)
        setNotes((ns) => ns.map((n) => (n.id === m.id ? { ...n, x: Math.max(0, nx), y: Math.max(0, ny) } : n)))
      } else if (m.kind === 'resize') {
        const nw = Math.max(150, m.origW + (e.clientX - m.startX))
        const nh = Math.max(140, m.origH + (e.clientY - m.startY))
        setNotes((ns) => ns.map((n) => (n.id === m.id ? { ...n, width: Math.round(nw), height: Math.round(nh) } : n)))
      }
    }
    const onUp = () => {
      const m = mode
      if (m.kind === 'drag') {
        const note = notes.find((n) => n.id === m.id)
        if (note) {
          fetch(`/api/board/${m.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ x: Math.max(0, note.x), y: Math.max(0, note.y), z: note.z }),
          }).catch(() => {})
        }
      } else if (m.kind === 'resize') {
        const note = notes.find((n) => n.id === m.id)
        if (note) {
          fetch(`/api/board/${m.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ width: note.width, height: note.height }),
          }).catch(() => {})
        }
      }
      setMode({ kind: 'idle' })
    }
    // a cancelled pointer (palm, gesture takeover) must release the note too,
    // or the board freezes: mode never returns to idle
    const onCancel = () => onUp()

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [mode, notes])

  const bringToFront = (id: string) => {
    topZ.current += 1
    const z = topZ.current
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, z } : n)))
    fetch(`/api/board/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ z }),
    }).catch(() => {})
  }

  /**
   * Press anywhere on a note: a drag moves it (the whole note is grabbable —
   * not just the little handle), a click on the paper opens the editor.
   * Pinned notes hold their ground; the paper still writes.
   */
  const onNotePointerDown = (e: React.PointerEvent, n: BoardNoteData) => {
    if (zoom || mode.kind !== 'idle') return
    const target = e.target as HTMLElement
    if (target.closest('button, textarea, input')) return
    const onHandle = !!target.closest('.board-note-handle')
    const onContent = !!target.closest('.board-note-content')
    // while this note is open for writing, only the handle may still drag it
    if (editingId === n.id && !onHandle) return
    if (e.button !== undefined && e.button !== 0) return

    press.current = { id: n.id, startX: e.clientX, startY: e.clientY, moved: false, onContent, onHandle }

    const onMove = (ev: PointerEvent) => {
      const p = press.current
      if (!p || p.moved) return
      const dx = ev.clientX - p.startX
      const dy = ev.clientY - p.startY
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      // pinned notes refuse to travel — play rattle animation
      if (n.pinned) {
        setRattleId(n.id)
        setTimeout(() => setRattleId(null), 420)
        return
      }
      p.moved = true
      press.current = null
      bringToFront(n.id)
      setMode({ kind: 'drag', id: n.id, startX: p.startX, startY: p.startY, origX: n.x, origY: n.y })
    }
    const onUp = () => {
      const p = press.current
      press.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      if (p && !p.moved && p.onContent) {
        // Sticky notes are ONE-TIME WRITING: once created, they cannot be edited.
        if (n.type !== 'sticky') {
          setEditingId(n.id)
          setEditDraft(n.content)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  /** handle drags even while the note is being edited (handled by the note's
   *  own press logic through bubbling) */
  const onHandlePointerDown = (e: React.PointerEvent) => {
    void e
  }

  const startResize = (e: React.PointerEvent, n: BoardNoteData) => {
    // Pin locks POSITION, not size — a pinned note still stretches in place.
    // (Refusing silently here was the "can't resize" dead end.)
    if (zoom) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // Keep the gesture alive if the finger drifts off the tiny handle.
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {}
    if (!n.pinned) bringToFront(n.id)
    setMode({ kind: 'resize', id: n.id, startX: e.clientX, startY: e.clientY, origW: n.width, origH: n.height })
  }

  /** Pin / unpin. Pinned: cannot be moved; writing is still allowed. */
  const togglePin = (id: string) => {
    if (zoom) return
    const note = notes.find((n) => n.id === id)
    if (!note) return
    const pinned = !note.pinned
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, pinned } : n)))
    fetch(`/api/board/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    }).catch(() => {})
  }

  const addNote = (type: 'sticky' | 'card') => {
    if (zoom) return
    setDraftModal({
      open: true,
      content: '',
      color: newColor,
      type,
    })
  }

  const submitDraft = async () => {
    const text = draftModal.content.trim()
    if (!text || addingRef.current) return
    const { color, type } = draftModal
    // One flight at a time (addingRef was declared but never used): double
    // taps queue behind the first instead of minting twins.
    addingRef.current = true
    // Reuse the key when retrying the same unsent draft within 10s.
    const bodySig = `${color}|${type}|${text}`
    const kept = draftFailKey.current
    const idemKey =
      kept && Date.now() - kept.at < 10_000 && kept.body === bodySig
        ? kept.key
        : typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setDraftModal((prev) => ({ ...prev, open: false }))
    try {
      const board = boardRef.current
      const bw = board?.clientWidth ?? 800
      const bh = board?.clientHeight ?? 600
      const count = notes.length
      const width = type === 'card' ? 300 : 230
      const height = type === 'card' ? 210 : 230
      const homeX = -pan.current.x / (zoomRef.current ? BOARD_ZOOM : 1)
      const homeY = -pan.current.y / (zoomRef.current ? BOARD_ZOOM : 1)
      const x = Math.min(Math.max(24, homeX + 80 + (count % 5) * 68 + Math.random() * 40), Math.max(24, homeX + bw - width - 24))
      const y = Math.min(Math.max(24, homeY + 70 + (count % 4) * 64 + Math.random() * 36), Math.max(24, homeY + bh - height - 24))
      const res = await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': idemKey },
        body: JSON.stringify({ content: text, color, type, x: Math.round(x), y: Math.round(y), width, height }),
      })
      if (res.ok) {
        draftFailKey.current = null
        const { note } = await res.json()
        setNotes((ns) => [...ns, note])
        topZ.current = Math.max(topZ.current, note.z)
        if (dayFilter && localDayKey(note.createdAt) !== dayFilter) applySlot(0)
        // Land directly in edit mode so the fresh note can be written on at once.
        setEditDraft(note.content ?? '')
        setEditingId(note.id)
        toast({
          title: type === 'sticky' ? 'Sticky Note Placed' : 'Note Card Placed',
          description: 'Permanent note written and saved to database.',
          className: 'toast-ink',
        })
      } else {
        draftFailKey.current = { key: idemKey, body: bodySig, at: Date.now() }
      }
    } catch {
      draftFailKey.current = { key: idemKey, body: bodySig, at: Date.now() }
    } finally {
      addingRef.current = false
    }
  }

  /** Copy a note onto a fresh page of the book — the note stays on the board. */
  const sendToBook = async (note: BoardNoteData) => {
    if (zoom || sendingId) return
    setSendingId(note.id)
    try {
      const res = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: note.content ?? '', title: note.type === 'sticky' ? 'From a sticky note' : 'From a note card' }),
      })
      if (res.ok) {
        const d = await res.json()
        onPagesChanged?.()
        toast({
          title: 'Added to the book',
          description: `Written onto page ${d.page.pageNumber}. The note stays on the board too.`,
          className: 'toast-ink',
        })
      }
    } catch { /* offline: nothing happens */ }
    setSendingId(null)
  }

  const saveEdit = async (id: string) => {
    const res = await fetch(`/api/board/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editDraft }),
    })
    if (res.ok) {
      const { note } = await res.json()
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, content: note.content } : n)))
      toast({
        title: 'Note Saved',
        description: 'Updated in database.',
        className: 'toast-ink',
      })
    }
    setEditingId(null)
  }

  const recolor = (id: string, color: string) => {
    if (zoom) return
    setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, color } : n)))
    fetch(`/api/board/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    }).catch(() => {})
  }

  /** Soft-delete + undo toast: the note is stored in the trash and can be
   *  reverted at any time from here or from the trash view. */
  const deleteNote = async (id: string) => {
    if (zoom) return
    const snapshot = notes.find((n) => n.id === id)
    const res = await fetch(`/api/board/${id}`, { method: 'DELETE' })
    if (!res.ok) return
    setNotes((ns) => ns.filter((n) => n.id !== id))
    if (snapshot) setTrash((ts) => [...ts, { ...snapshot, deletedAt: new Date().toISOString() }])
    toast({
      title: 'Note moved to trash',
      description: 'It stays in the database until you empty it.',
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

  const restoreNote = async (id: string) => {
    if (zoom) return
    const res = await fetch(`/api/board/${id}/restore`, { method: 'POST' })
    if (res.ok) {
      const { note } = await res.json()
      setTrash((ts) => ts.filter((n) => n.id !== id))
      setNotes((ns) => [...ns, note])
      topZ.current = Math.max(topZ.current, note.z)
      toast({
        title: 'Note Restored',
        description: 'The note has returned to the board.',
        className: 'toast-ink',
      })
    }
  }

  // Two-tap destructive confirms (mobile-safe, no blocking dialogs).
  const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const armConfirm = (set: (v: any) => void, value: any) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    set(value)
    confirmTimer.current = setTimeout(() => {
      setConfirmPurgeId(null)
      setConfirmEmpty(false)
    }, 3500)
  }

  /** Permanently delete one trashed note (no undo — trash is the undo). */
  const purgeNote = async (id: string) => {
    if (zoom) return
    if (confirmPurgeId !== id) {
      armConfirm(setConfirmPurgeId, id)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmPurgeId(null)
    const res = await fetch(`/api/board/${id}?hard=1`, { method: 'DELETE' })
    if (res.ok) {
      setTrash((ts) => ts.filter((n) => n.id !== id))
      toast({
        title: 'Note Permanently Deleted',
        description: 'It cannot be restored.',
        className: 'toast-ink',
      })
    } else {
      const d = await res.json().catch(() => ({}))
      toast({
        title: 'Could not delete note',
        description: (d as any)?.error || 'Try again in a moment.',
        variant: 'destructive',
      })
    }
  }

  /** Permanently delete every trashed note. */
  const emptyTrash = async () => {
    if (zoom || trash.length === 0) return
    if (!confirmEmpty) {
      armConfirm(setConfirmEmpty, true)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmEmpty(false)
    const res = await fetch('/api/board?emptyTrash=1', { method: 'DELETE' })
    if (res.ok) {
      const d = await res.json().catch(() => ({ purged: trash.length }))
      setTrash([])
      toast({
        title: 'Trash Emptied',
        description: `${(d as any)?.purged ?? trash.length} notes permanently deleted.`,
        className: 'toast-ink',
      })
    } else {
      toast({
        title: 'Could not empty trash',
        description: 'Try again in a moment.',
        variant: 'destructive',
      })
    }
  }

  const notesSorted = useMemo(() => [...notes].sort((a, b) => a.z - b.z), [notes])

  /** the timeline rail: notes grouped by the day they were written */
  const dayGroups = useMemo(() => {
    const byDay = new Map<string, BoardNoteData[]>()
    notes.forEach((n) => {
      const k = localDayKey(n.createdAt)
      const arr = byDay.get(k)
      if (arr) arr.push(n)
      else byDay.set(k, [n])
    })
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [notes])

  /** reactive day keys for render; the ref mirror below serves callbacks */
  const dayKeys = useMemo(() => dayGroups.map(([k]) => k), [dayGroups])

  // keep the slider's day keys in step with the notes; a day that arrives
  // after the board was laid out (a fresh note) pulses so it is noticed —
  // the slider grows to hold it automatically
  useEffect(() => {
    const keys = dayGroups.map(([k]) => k)
    dayKeysRef.current = keys
    if (seenDays.current.size === 0) {
      keys.forEach((k) => seenDays.current.add(k))
      return
    }
    const fresh = keys.find((k) => !seenDays.current.has(k))
    if (!fresh) return
    keys.forEach((k) => seenDays.current.add(k))
    setPulseDay(fresh)
  }, [dayGroups])

  // the pulse itself decays on its own timer — kept separate so unrelated
  // notes updates (drags) can never cancel the reset and leave it stuck on
  useEffect(() => {
    if (!pulseDay) return
    const t = setTimeout(() => setPulseDay(null), 1800)
    return () => clearTimeout(t)
  }, [pulseDay])

  // deleting the last note of the filtered day would leave every note
  // hidden — fall back to All instead of an empty felt
  useEffect(() => {
    if (dayFilter && dayGroups.length > 0 && !dayGroups.some(([k]) => k === dayFilter)) {
      applySlot(0)
    }
  }, [dayGroups, dayFilter, applySlot])

  if (!open) return null

  const exit = closing

  return (
    <div className={`board-overlay ${exit ? 'board-overlay--exit' : 'board-overlay--enter'} ${expanded ? 'board-overlay--expanded' : ''}`}>
      <div className={`board-shell ${exit ? 'board-shell--exit' : 'board-shell--enter'} ${expanded ? 'board-shell--expanded' : ''}`}>
        <header className="board-toolbar">
          <button type="button" className="board-back" onClick={requestClose}>
            <ArrowLeft size={16} strokeWidth={2} />
            <span>Back to the book</span>
          </button>
          <div className="board-title">
            <Pin size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>Notes Board</span>
            <span className="board-count">{showTrash ? `${trash.length} in trash` : notes.length}</span>
          </div>
          <div className="board-actions">
            {!showTrash && (
              <>
                <div className="color-dots color-dots--board" role="radiogroup" aria-label="New note color">
                  {NOTE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={newColor === c}
                      aria-label={c}
                      disabled={zoom}
                      className={`color-dot ${newColor === c ? 'color-dot--on' : ''} ${zoom ? 'color-dot--off' : ''}`}
                      style={{ background: COLOR_HEX[c] }}
                      onClick={() => setNewColor(c)}
                    />
                  ))}
                </div>
                <button type="button" className="board-add" disabled={zoom} onClick={() => addNote('sticky')}>
                  <StickyNote size={14} strokeWidth={1.8} />
                  Sticky
                </button>
                <button type="button" className="board-add board-add--card" disabled={zoom} onClick={() => addNote('card')}>
                  <FileText size={14} strokeWidth={1.8} />
                  Note card
                </button>
              </>
            )}
            <button
              type="button"
              className={`board-zoom-toggle ${zoom ? 'board-zoom-toggle--on' : ''}`}
              onClick={toggleZoom}
              aria-pressed={zoom}
              aria-label={zoom ? 'Turn reading zoom off' : 'Zoom in to read (editing paused)'}
              title={zoom ? 'Zoom out — notes editable again' : 'Zoom in to read precisely (editing paused)'}
            >
              {zoom ? <ZoomOut size={15} strokeWidth={2} /> : <ZoomIn size={15} strokeWidth={2} />}
            </button>
            <button
              type="button"
              className={`board-trash-toggle ${showTrash ? 'board-trash-toggle--on' : ''}`}
              onClick={() => setShowTrash((s) => !s)}
              aria-pressed={showTrash}
              aria-label={showTrash ? 'Back to live notes' : 'Show trashed notes'}
              title={showTrash ? 'Live notes' : 'Trash'}
            >
              <Trash2 size={15} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className={`board-expand-toggle ${expanded ? 'board-expand-toggle--on' : ''}`}
              onClick={toggleExpand}
              aria-pressed={expanded}
              aria-label={expanded ? 'Restrain the board' : 'Expand the board edge to edge'}
              title={expanded ? 'Back to the framed board' : 'Expand edge to edge'}
            >
              {expanded ? <Minimize2 size={15} strokeWidth={1.9} /> : <Maximize2 size={15} strokeWidth={1.9} />}
            </button>
          </div>
        </header>

        <div
          className={`board-surface ${zoom ? 'board-surface--zoom' : ''} ${panned ? 'board-surface--panned' : ''}`}
          ref={boardRef}
          onPointerDown={onSurfacePointerDown}
          onDoubleClick={(e) => {
            // quick capture: double-click the empty felt and a sticky appears
            if (zoom || loading || showTrash) return
            const target = e.target as HTMLElement
            if (target.closest('.board-note, .board-timeline, .board-home, .board-empty, button')) return
            addNote('sticky')
          }}
        >
          {zoom && (
            <div className="board-zoom-note" aria-live="polite">
              <ZoomIn size={12} strokeWidth={2} aria-hidden="true" />
              Reading zoom · notes are still, nothing can be edited
            </div>
          )}

          {loading ? (
            <div className="board-loading">
              <Loader2 className="spin" size={22} strokeWidth={2} />
              <span className="board-loading-title">
                {loadStage === 'reading' ? 'Reading the notes cluster' : 'Arranged'}
              </span>
              <span className="board-loading-sub">
                {loadStage === 'reading'
                  ? 'reaching TiDB · fetching every note · the trash'
                  : loadInfo
                    ? `${loadInfo.notes} notes across ${loadInfo.days === 0 ? 0 : loadInfo.days} day${loadInfo.days === 1 ? '' : 's'}, laid out as you left them`
                    : ''}
              </span>
            </div>
          ) : showTrash ? (
            <div className="board-notes">
              {trash.length === 0 ? (
                <div className="board-empty">
                  <Trash2 size={30} strokeWidth={1.2} />
                  <p>Nothing in the trash. Deleted notes wait here so you can restore them.</p>
                </div>
              ) : (
                <>
                  <div className="board-trash-bar">
                    <span className="board-trash-count">
                      {trash.length} trashed note{trash.length === 1 ? '' : 's'}
                    </span>
                    <button
                      type="button"
                      className={`board-trash-empty ${confirmEmpty ? 'board-trash-empty--armed' : ''}`}
                      onClick={emptyTrash}
                      aria-label={confirmEmpty ? 'Tap again to permanently delete all trashed notes' : 'Empty trash'}
                      title={confirmEmpty ? 'Tap again to confirm' : 'Empty trash — permanently deletes all'}
                    >
                      <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                      {confirmEmpty ? 'Tap again to empty' : 'Empty trash'}
                    </button>
                  </div>
                  {trash.map((n) => (
                  <div
                    key={n.id}
                    className={`board-note board-note--trashed board-note--${n.type}${n.type === 'sticky' ? ` board-note--${n.color}` : ''}`}
                    style={{ left: n.x, top: n.y, width: n.width, height: n.height, zIndex: n.z }}
                  >
                    <div className="board-note-handle">
                      <GripVertical size={14} strokeWidth={2} aria-hidden="true" />
                      <span className="board-note-date">deleted {relativeTime(n.deletedAt ?? n.updatedAt)}</span>
                    </div>
                    {n.type === 'sticky' && <div className="board-note-fold" aria-hidden="true" />}
                    <button
                      type="button"
                      className="board-note-restore"
                      onClick={() => restoreNote(n.id)}
                    >
                      <RotateCcw size={12} strokeWidth={2} />
                      Restore
                    </button>
                    <button
                      type="button"
                      className={`board-note-purge ${confirmPurgeId === n.id ? 'board-note-purge--armed' : ''}`}
                      onClick={() => purgeNote(n.id)}
                      aria-label={confirmPurgeId === n.id ? 'Tap again to permanently delete this note' : 'Delete this note forever'}
                      title={confirmPurgeId === n.id ? 'Tap again to confirm permanent delete' : 'Delete forever (no undo)'}
                    >
                      <Trash2 size={12} strokeWidth={2} aria-hidden="true" />
                      {confirmPurgeId === n.id ? 'Sure?' : 'Delete'}
                    </button>
                    <div className="board-note-content">
                      {n.content || <span className="board-note-placeholder">Empty note</span>}
                    </div>
                  </div>
                ))}
                </>
              )}
            </div>
          ) : notes.length === 0 ? (
            <div className="board-empty">
              <StickyNote size={34} strokeWidth={1.2} />
              <p>Nothing pinned yet. Sticky notes and note cards live here, and every change is saved to the notes cluster.</p>
            </div>
          ) : (
            <div className={`board-notes ${zoom ? 'board-notes--ro' : ''}`} ref={layerRef}>
              {notesSorted.map((n, i) => {
                const dayoff = dayFilter != null && localDayKey(n.createdAt) !== dayFilter
                return (
                  <div
                    key={n.id}
                    className={`board-note board-note--enter board-note--${n.type}${n.type === 'sticky' ? ` board-note--${n.color}` : ''} ${n.pinned ? 'board-note--pinned' : ''} ${dayoff ? 'board-note--dayoff' : ''} ${mode.kind !== 'idle' && mode.id === n.id ? 'board-note--dragging' : ''} ${rattleId === n.id ? 'board-note--rattling' : ''}`}
                    style={{
                      left: n.x,
                      top: n.y,
                      width: n.width,
                      height: n.height,
                      zIndex: n.z,
                      ['--rot' as string]: `${n.rotation}deg`,
                      animationDelay: `${0.04 + i * 0.045}s`,
                    }}
                    onPointerDown={(e) => onNotePointerDown(e, n)}
                  >
                    {/* Frosted masking tape on unpinned notes (Image 4) */}
                    {n.type === 'sticky' && !n.pinned && (
                      <div className="board-note-tape" aria-hidden="true" />
                    )}

                    {/* 3D red pushpin with drop shadow on pinned notes (Image 4) */}
                    {n.pinned && (
                      <div className="board-note-pushpin-3d" aria-hidden="true">
                        <svg viewBox="0 0 32 38" width="28" height="34">
                          <defs>
                            <radialGradient id={`pinHead-${n.id}`} cx="35%" cy="30%" r="65%">
                              <stop offset="0%" stopColor="#ff7676" />
                              <stop offset="45%" stopColor="#dc2626" />
                              <stop offset="85%" stopColor="#991b1b" />
                              <stop offset="100%" stopColor="#7f1d1d" />
                            </radialGradient>
                            <linearGradient id={`pinMetal-${n.id}`} x1="0" y1="0" x2="1" y2="1">
                              <stop offset="0%" stopColor="#f1f5f9" />
                              <stop offset="50%" stopColor="#94a3b8" />
                              <stop offset="100%" stopColor="#475569" />
                            </linearGradient>
                          </defs>
                          <g transform="rotate(-15 16 18)">
                            <line x1="16" y1="23" x2="16" y2="34" stroke={`url(#pinMetal-${n.id})`} strokeWidth="2.4" strokeLinecap="round" />
                            <ellipse cx="16" cy="21" rx="5.5" ry="2.2" fill="#7f1d1d" />
                            <path d="M12 14 C12 17.5, 14 20, 16 21 C18 20, 20 17.5, 20 14 Z" fill={`url(#pinHead-${n.id})`} />
                            <ellipse cx="16" cy="11" rx="7.5" ry="3.8" fill={`url(#pinHead-${n.id})`} />
                            <ellipse cx="14" cy="10" rx="3.5" ry="1.6" fill="rgba(255,255,255,0.65)" />
                          </g>
                        </svg>
                      </div>
                    )}

                    {/* Top Bar: Left has 6-dot grip (:::), Right has Pin, Delete & ToBook */}
                    <div className="board-note-top">
                      <div
                        className="board-note-grip"
                        onPointerDown={onHandlePointerDown}
                        title={n.pinned ? 'Pinned in place' : 'Drag note'}
                        aria-label="Drag grip"
                      >
                        <div className="board-note-grip-dot" />
                        <div className="board-note-grip-dot" />
                        <div className="board-note-grip-dot" />
                        <div className="board-note-grip-dot" />
                        <div className="board-note-grip-dot" />
                        <div className="board-note-grip-dot" />
                      </div>

                      <div className="board-note-actions">
                        <button
                          type="button"
                          className={`board-note-btn ${n.pinned ? 'board-note-btn--pin-active' : ''}`}
                          disabled={zoom}
                          aria-pressed={n.pinned}
                          aria-label={n.pinned ? 'Unpin note' : 'Pin note'}
                          title={n.pinned ? 'Unpin — note can move again' : 'Pin in place'}
                          onClick={(e) => {
                            e.stopPropagation()
                            togglePin(n.id)
                          }}
                        >
                          <Pin size={15} strokeWidth={2.2} />
                        </button>

                        <button
                          type="button"
                          className="board-note-btn"
                          aria-label="Delete note"
                          title="Delete note"
                          disabled={zoom}
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteNote(n.id)
                          }}
                        >
                          <Trash2 size={15} strokeWidth={2} />
                        </button>

                        <button
                          type="button"
                          className="board-note-btn"
                          aria-label="Copy to book"
                          title="Make a book page of this note"
                          disabled={zoom || sendingId === n.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            sendToBook(n)
                          }}
                        >
                          {sendingId === n.id ? <Loader2 size={14} className="spin" /> : <BookPlus size={14} strokeWidth={2} />}
                        </button>
                      </div>
                    </div>

                    {/* Content area: Permanent one-time writing */}
                    {editingId === n.id ? (
                      <div className="board-note-editor">
                        <textarea
                          ref={editRef}
                          value={editDraft}
                          placeholder="Write something"
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit(n.id)
                            if (e.key === 'Escape') {
                              e.stopPropagation()
                              setEditingId(null)
                            }
                          }}
                        />
                        <div className="board-note-editor-actions">
                          <button type="button" className="btn-mini btn-mini--ghost" onClick={() => setEditingId(null)} aria-label="Revert to saved note" title="Revert to saved">
                            <RotateCcw size={13} strokeWidth={2} />
                          </button>
                          <button type="button" className="btn-mini btn-mini--save" onClick={() => saveEdit(n.id)} aria-label="Save note" title="Save (Ctrl+Enter)">
                            <Check size={13} strokeWidth={2.2} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div
                        className="board-note-content"
                        title={n.pinned ? 'Pinned in place' : 'Drag note anywhere'}
                      >
                        {n.content || <span className="board-note-placeholder">Empty note</span>}
                      </div>
                    )}

                    {/* Bottom Bar: color swatches on stickies only — cards stay fixed cream */}
                    <div className="board-note-bottom">
                      {n.type === 'sticky' && (
                      <div className="board-note-swatches">
                        {NOTE_COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            aria-label={`Color ${c}`}
                            className={`board-swatch ${n.color === c ? 'board-swatch--active' : ''}`}
                            style={{ background: COLOR_HEX[c] }}
                            onClick={(e) => {
                              e.stopPropagation()
                              recolor(n.id, c)
                            }}
                          />
                        ))}
                      </div>
                      )}
                      <span className="text-[10px] text-black/40 font-mono select-none pointer-events-none">
                        {relativeTime(n.createdAt || n.updatedAt)}
                      </span>
                    </div>

                    <button
                      type="button"
                      className="board-note-resize"
                      aria-label="Resize note"
                      onPointerDown={(e) => startResize(e, n)}
                      onClick={(e) => e.stopPropagation()}
                      tabIndex={-1}
                    >
                      <span />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* the day slider: drag the thumb through the days — notes from
              other days leave the felt as it passes and return when it
              slides back; fresh writing grows a new tick automatically */}
          {!loading && !showTrash && dayGroups.length > 0 && (
            <div className={`board-timeline ${dayFilter ? 'board-timeline--filtered' : ''}`}>
              <button
                type="button"
                className={`timeline-cap ${dayFilter == null ? 'timeline-cap--on' : ''}`}
                onClick={() => commitDay(null)}
                aria-pressed={dayFilter == null}
              >
                All
              </button>
              <div
                className="timeline-track"
                ref={trackRef}
                role="slider"
                tabIndex={zoom ? -1 : 0}
                aria-label="Notes by day — drag to travel through the days you wrote"
                aria-valuemin={0}
                aria-valuemax={dayGroups.length}
                aria-valuenow={dayFilter ? dayKeys.indexOf(dayFilter) + 1 : 0}
                aria-valuetext={dayFilter ? `${dayLabel(dayFilter)} · ${dayGroups.find(([k]) => k === dayFilter)?.[1].length ?? 0} notes` : 'All days'}
                onPointerDown={onTrackPointerDown}
                onKeyDown={onTrackKeyDown}
              >
                <span className="timeline-rail" aria-hidden="true" />
                {dayGroups.map(([key, group], gi) => {
                  const slot = gi + 1
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`timeline-tick ${dayFilter === key ? 'timeline-tick--on' : ''} ${pulseDay === key ? 'timeline-tick--new' : ''}`}
                      style={{ left: `${(slot / dayGroups.length) * 100}%` }}
                      onClick={(e) => {
                        e.stopPropagation()
                        commitDay(key)
                      }}
                      aria-label={`${dayLabel(key)} — ${group.length} note${group.length > 1 ? 's' : ''}`}
                      title={`${group.length} note${group.length > 1 ? 's' : ''} written ${key}`}
                    />
                  )
                })}
                <div
                  className="timeline-thumb"
                  ref={thumbRef}
                  style={{ left: `${dayFilter ? (dayKeys.indexOf(dayFilter) + 1) / dayGroups.length * 100 : 0}%` }}
                  aria-hidden="true"
                >
                  <span className="timeline-thumb-dot" />
                </div>
                {dayFilter && (
                  <span
                    className="timeline-flag"
                    ref={flagRef}
                    style={{ left: `${(dayKeys.indexOf(dayFilter) + 1) / dayGroups.length * 100}%` }}
                  >
                    {dayLabel(dayFilter)} · {dayGroups.find(([k]) => k === dayFilter)?.[1].length ?? 0}
                  </span>
                )}
              </div>
              <span className="timeline-cap timeline-cap--end">
                {dayLabel(dayGroups[dayGroups.length - 1][0])}
              </span>
            </div>
          )}

          {/* back to the start: one press returns home after exploring */}
          {!loading && panned && !showTrash && (
            <button
              type="button"
              className="board-home"
              onClick={goHome}
              aria-label="Back to the start of the board"
              title="Back to where you started"
            >
              <Crosshair size={14} strokeWidth={2} />
            </button>
          )}

          {/* New board-note draft modal — copy follows the chosen type */}
          {draftModal.open && (
            <div
              className="board-draft-modal"
              onClick={() => setDraftModal((d) => ({ ...d, open: false }))}
            >
              <div
                className={`board-draft-card${draftModal.type === 'sticky' ? ` board-note--${draftModal.color}` : ' board-note--card'}`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="board-draft-tape" aria-hidden="true" />
                <div className="flex items-center justify-between pb-2 mb-2 border-b border-black/10">
                  <span className="text-xs font-semibold uppercase tracking-wider text-black/60">
                    {draftModal.type === 'card' ? 'New Note Card' : 'New Sticky Note'}
                  </span>
                  <button
                    type="button"
                    className="text-black/50 hover:text-black cursor-pointer"
                    onClick={() => setDraftModal((d) => ({ ...d, open: false }))}
                    aria-label="Close"
                  >
                    <X size={15} />
                  </button>
                </div>
                <textarea
                  autoFocus
                  className="board-draft-textarea"
                  placeholder={draftModal.type === 'card' ? 'Write your card here…' : 'Write your note here…'}
                  value={draftModal.content}
                  onChange={(e) => setDraftModal((d) => ({ ...d, content: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      submitDraft()
                    }
                    if (e.key === 'Escape') {
                      setDraftModal((d) => ({ ...d, open: false }))
                    }
                  }}
                />
                <div className="board-draft-footer">
                  {draftModal.type === 'sticky' && (
                  <div className="flex items-center gap-1.5">
                    {NOTE_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`board-swatch ${draftModal.color === c ? 'board-swatch--active' : ''}`}
                        style={{ background: COLOR_HEX[c] }}
                        onClick={() => setDraftModal((d) => ({ ...d, color: c }))}
                        aria-label={`Color ${c}`}
                      />
                    ))}
                  </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="board-draft-btn-cancel"
                      onClick={() => setDraftModal((d) => ({ ...d, open: false }))}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="board-draft-btn-post"
                      onClick={submitDraft}
                    >
                      {draftModal.type === 'card' ? 'Place Card' : 'Stick to Board'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
