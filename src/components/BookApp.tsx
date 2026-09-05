'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  BookOpen, StickyNote, X, ChevronLeft, ChevronRight, NotebookPen, Database,
  ZoomIn, ZoomOut, ArrowRight, BookMarked, FilePlus2, Trash2, Loader2, Download, Type, Eye, Sparkles,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import BookStage, { BookStageHandle, StagePhase } from './book/BookStage'
import SearchBar from './book/SearchBar'
import NotesPanel from './book/NotesPanel'
import IndexPanel from './book/IndexPanel'
import BoardView from './board/BoardView'
import type { BookData, PageData, PageNoteData } from '@/lib/types'
import IdentityGate from './IdentityGate'
import { HEARTBEAT_MS } from '@/lib/identity'
import {
  loadIdentity,
  saveIdentity,
  freshGuestIdentity,
  getTabId,
  type LocalIdentity,
} from '@/lib/identity-client'

export interface PresenceUserView {
  clientId: string
  tabId: string
  name: string
  color: string
  pageId: string | null
  activity: 'editing' | 'viewing'
  updatedAt: string
}

export interface PageLockView {
  pageId: string
  clientId: string
  name: string
  color: string
  updatedAt: string
}

interface OverflowState {
  pageId: string
  pageNumber: number
  holder: { name: string; color: string; clientId: string }
}
import { isBlankHtml } from '@/lib/sanitize'

interface Display {
  left: number
  right: number
}

interface LoadState {
  stage: 'reading' | 'arranged'
  pages?: number
  notes?: number
  board?: number
}

export const HANDWRITING_FONTS = [
  { id: 'Caveat', label: 'Caveat (Casual Pen)', sample: 'What the hand formats' },
  { id: 'Kalam', label: 'Kalam (Natural Ink)', sample: 'What the hand formats' },
  { id: 'Patrick Hand', label: 'Patrick Hand (Felt Tip)', sample: 'What the hand formats' },
  { id: 'Dancing Script', label: 'Dancing Script (Cursive)', sample: 'What the hand formats' },
] as const

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** fetch with a hard timeout so flaky mobile networks can't hang the UI forever. */
const FETCH_TIMEOUT_MS = 15000
async function fetchWithTimeout(input: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}
function isTimeoutError(e: unknown) {
  return e instanceof DOMException && e.name === 'AbortError'
}

export default function BookApp() {
  const { toast } = useToast()
  const [phase, setPhase] = useState<StagePhase>('front')
  const [boardOpen, setBoardOpen] = useState(false)
  const [book, setBook] = useState<BookData | null>(null)
  const [pages, setPages] = useState<PageData[]>([])
  const [allNotes, setAllNotes] = useState<PageNoteData[]>([])
  // Board (sticky) count for the front-cover pill — fetched once up front.
  const [boardCount, setBoardCount] = useState(0)
  // Last-opened stamp for the "Last opened …" pill. Always null on first
  // render (server has no localStorage) — loaded client-side to avoid
  // hydration mismatch. Stamped on every real open.
  const [lastOpened, setLastOpened] = useState<number | null>(null)
  const [display, setDisplay] = useState<Display>({ left: 0, right: 1 })
  const [notesPanelOpen, setNotesPanelOpen] = useState(false)
  const [notesTarget, setNotesTarget] = useState<number | null>(null)
  const [indexOpen, setIndexOpen] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)
  const [dbOk, setDbOk] = useState<boolean | null>(null)
  // reading zoom: magnifies the book and makes pages + notes read-only
  const [zoomed, setZoomed] = useState(false)
  // handwriting font style preference — initial value comes from the lazy
  // initializer so no setState-in-effect is needed on mount
  const [activeFont, setActiveFont] = useState<string>(() => {
    if (typeof window === 'undefined') return 'Kalam'
    try {
      return localStorage.getItem('libris_handwriting_font') || 'Kalam'
    } catch {
      return 'Kalam'
    }
  })
  const [fontPickerOpen, setFontPickerOpen] = useState(false)
  // the veil shown while the clusters are read before the book opens
  const [loadState, setLoadState] = useState<LoadState | null>(null)
  // page waiting for a remove confirmation
  const [confirmPage, setConfirmPage] = useState<PageData | null>(null)
  // freshly created page — its paper takes the caret
  const [focusPageId, setFocusPageId] = useState<string | null>(null)
  // identity (null until the gate resolves) + presence snapshot.
  // Server renders null; stored identity + guest draft load client-side to
  // avoid hydration mismatch.
  const [identity, setIdentity] = useState<LocalIdentity | null>(null)
  const [guestDraft, setGuestDraft] = useState<LocalIdentity | null>(null)
  const [users, setUsers] = useState<PresenceUserView[]>([])
  const [locks, setLocks] = useState<PageLockView[]>([])
  const [myLockedPages, setMyLockedPages] = useState<string[]>([])
  const [overflow, setOverflow] = useState<OverflowState | null>(null)
  const [tabId] = useState(() => (typeof window === 'undefined' ? '' : getTabId()))
  const lastActivityAt = useRef(0)
  const versionsRef = useRef<string | null>(null)

  // Watchers side-tag drag (ref-driven: no re-renders mid-drag) + persisted spot.
  const watchTagRef = useRef<HTMLDivElement | null>(null)
  const watchDrag = useRef<{ dx: number; dy: number } | null>(null)
  // Last-opened pill: measured against the real book corner at runtime.
  const openedPillRef = useRef<HTMLDivElement | null>(null)

  /** Pin the last-opened pill to the book volume's bottom-right corner. */
  useEffect(() => {
    if (phase !== 'front' || lastOpened === null) return
    const place = () => {
      const pill = openedPillRef.current
      const vol = document.querySelector('.book-volume') as HTMLElement | null
      if (!pill || !vol) return
      const r = vol.getBoundingClientRect()
      const pw = pill.offsetWidth
      const ph = pill.offsetHeight
      // Straddle the corner itself: pill hanging just off the right edge,
      // vertically over the bottom edge — skewed italic (/) for style.
      const left = Math.min(
        Math.max(8, r.right - pw / 2 + 26),
        window.innerWidth - pw - 8
      )
      const top = Math.min(
        Math.max(8, r.bottom - ph / 2 - 6),
        window.innerHeight - ph - 8
      )
      pill.style.left = `${left}px`
      pill.style.top = `${top}px`
      pill.style.right = 'auto'
      pill.style.bottom = 'auto'
      pill.style.transform = 'skewX(-12deg)'
    }
    // The book glides in on entrance — measure after it settles, not mid-flight.
    const raf = requestAnimationFrame(() => requestAnimationFrame(place))
    const t1 = window.setTimeout(place, 650)
    const t2 = window.setTimeout(place, 1400)
    window.addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(t1)
      window.clearTimeout(t2)
      window.removeEventListener('resize', place)
    }
  }, [phase, lastOpened])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('libris_watchtag_pos')
      const el = watchTagRef.current
      if (raw && el) {
        const p = JSON.parse(raw) as { left: number; top: number }
        if (Number.isFinite(p.left) && Number.isFinite(p.top)) {
          el.style.left = `${Math.min(Math.max(0, p.left), window.innerWidth - 48)}px`
          el.style.top = `${Math.min(Math.max(0, p.top), window.innerHeight - 40)}px`
          el.style.transform = 'none'
        }
      }
    } catch {}
  }, [])

  const onWatchTagDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = watchTagRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    watchDrag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top }
    el.setPointerCapture(e.pointerId)
    el.style.cursor = 'grabbing'
    el.style.transform = 'none'
    const move = (ev: PointerEvent) => {
      const d = watchDrag.current
      const t = watchTagRef.current
      if (!d || !t) return
      t.style.left = `${Math.min(Math.max(0, ev.clientX - d.dx), window.innerWidth - 48)}px`
      t.style.top = `${Math.min(Math.max(0, ev.clientY - d.dy), window.innerHeight - 40)}px`
    }
    const up = (ev: PointerEvent) => {
      const t = watchTagRef.current
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      watchDrag.current = null
      if (t) {
        t.style.cursor = 'grab'
        try {
          localStorage.setItem(
            'libris_watchtag_pos',
            JSON.stringify({ left: parseFloat(t.style.left) || 0, top: parseFloat(t.style.top) || 0 })
          )
        } catch {}
      }
      void ev
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }, [])

  // DOM side-effect only: keep the CSS variable in sync with the font state
  useEffect(() => {
    document.documentElement.style.setProperty('--active-font', `'${activeFont}', cursive`)
  }, [activeFont])

  const selectHandwritingFont = (font: string) => {
    setActiveFont(font)
    document.documentElement.style.setProperty('--active-font', `'${font}', cursive`)
    try {
      localStorage.setItem('libris_handwriting_font', font)
    } catch {}
    toast({
      title: 'Handwriting Style',
      description: `Active font: ${font}`,
      className: 'toast-ink',
    })
  }

  useEffect(() => {
    if (!fontPickerOpen) return
    const onMouseDown = () => setFontPickerOpen(false)
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [fontPickerOpen])

  const stageRef = useRef<BookStageHandle>(null)
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedPage = useRef(1)
  const pagesRef = useRef<PageData[]>([])
  // Mirror latest pages for timeout/event callbacks. Assigned in an effect
  // (not during render) so the refs rule holds; effects run before any
  // sweepEmptyPages timeout fires, so timeouts still see fresh data.
  useEffect(() => {
    pagesRef.current = pages
  }, [pages])
  // Same mirror for the current spread (sweep corrections must not close over
  // a stale display while the reader keeps turning pages).
  const displayRef = useRef<Display>({ left: 0, right: 1 })
  useEffect(() => {
    displayRef.current = display
  }, [display])

  /**
   * Unsaved autosave patches by page id. A server page list arriving while a
   * PATCH is still in flight (or failed) must NEVER clobber what the user
   * sees — otherwise typed words vanish from the screen AND the page looks
   * server-blank, which used to get it swept away. Every server list goes
   * through applyServerPages, which overlays these drafts back on.
   */
  const pendingEdits = useRef<Map<string, { content?: string; title?: string }>>(new Map())

  const applyServerPages = useCallback((serverPages: PageData[]) => {
    const pending = pendingEdits.current
    if (pending.size === 0) {
      setPages(serverPages)
      return
    }
    const ids = new Set(serverPages.map((p) => p.id))
    // Drop drafts for pages the server no longer has (deleted elsewhere).
    for (const id of [...pending.keys()]) {
      if (!ids.has(id)) pending.delete(id)
    }
    if (pending.size === 0) {
      setPages(serverPages)
      return
    }
    setPages(serverPages.map((p) => {
      const draft = pending.get(p.id)
      return draft ? { ...p, ...draft } : p
    }))
  }, [])
  // one page creation at a time — a second press while the POST is in
  // flight must not mint a twin page
  const creatingPage = useRef(false)
  // freshly minted pages cannot be auto-swept for a short grace window,
  // even if the reader wanders off before writing
  const freshPages = useRef<Map<string, number>>(new Map())
  // the moment the last page was created (rapid-click debounce)
  const lastCreateAt = useRef(0)
  // last failed create intent, for idempotency-key reuse on immediate retry
  const createFailKey = useRef<{ key: string; after: number | null; at: number } | null>(null)
  // sweep re-entrancy guard (M-6): separate ref, never mutate the callback
  const sweepRunning = useRef(false)
  // narrow layout (single page mode) — the index hides its flyleaf row there
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 900)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---------- initial data (front page) ----------
  useEffect(() => {
    let cancelled = false
    fetchWithTimeout('/api/book', undefined, 12000)
      .then(async (r) => {
        if (!r.ok) throw new Error(`book API ${r.status}`)
        return r.json()
      })
      .then((d) => {
        if (cancelled) return
        setBook(d.book)
        applyServerPages(d.pages)
        lastSavedPage.current = d.book?.lastPage ?? 1
        setDisplay({ left: 0, right: 1 })
        return fetchWithTimeout(`/api/notes?bookId=${d.book.id}`, undefined, 12000)
      })
      .then((r) => (r && r.ok ? r.json() : { notes: [] }))
      .then((d) => {
        if (!cancelled) setAllNotes(d.notes ?? [])
        return fetchWithTimeout('/api/board', undefined, 12000)
      })
      .then((r) => (r && r.ok ? r.json() : { notes: [] }))
      .then((d) => {
        if (!cancelled) setBoardCount((d.notes ?? []).length)
      })
      .catch((e) => {
        console.error('Failed to load book data:', e)
        if (!cancelled) {
          setDbError(
            isTimeoutError(e)
              ? 'The database is taking too long to answer (slow network?). Check your connection and reopen.'
              : 'Could not reach the database clusters. Make sure both TiDB clusters are running.'
          )
        }
      })
    return () => { cancelled = true }
  }, [])

  // cluster health check for front-page indicator
  useEffect(() => {
    let cancelled = false
    fetchWithTimeout('/api/health', undefined, 8000)
      .then((r) => { if (!cancelled) setDbOk(r.ok) })
      .catch(() => { if (!cancelled) setDbOk(false) })
    return () => { cancelled = true }
  }, [])

  // Load (or seed) the last-accessed stamp client-side only.
  // Stored identity + guest draft also resolve here (never during render).
  useEffect(() => {
    setIdentity(loadIdentity())
    setGuestDraft(freshGuestIdentity())
    try {
      const raw = localStorage.getItem('libris_last_opened')
      const t = raw ? Number(raw) : 0
      if (Number.isFinite(t) && t > 0) {
        setLastOpened(t)
      } else {
        const now = Date.now()
        localStorage.setItem('libris_last_opened', String(now))
        setLastOpened(now)
      }
    } catch {}
  }, [])

  // network connection notifications
  useEffect(() => {
    const onOffline = () => {
      toast({
        title: 'Offline Mode',
        description: 'Network disconnected. Local drafts preserved.',
        variant: 'destructive',
      })
    }
    const onOnline = () => {
      toast({
        title: 'Online',
        description: 'Network connection restored. Synced with database.',
        className: 'toast-ink',
      })
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [toast])

  const noteCounts = useMemo(() => {
    const m: Record<number, number> = {}
    allNotes.forEach((n) => {
      m[n.pageNumber] = (m[n.pageNumber] ?? 0) + 1
    })
    return m
  }, [allNotes])

  const pageByNum = useMemo(() => {
    const m = new Map<number, PageData>()
    pages.forEach((p) => m.set(p.pageNumber, p))
    return m
  }, [pages])

  /** Foreign edit leases by page number (for banners + read-only faces). */
  const pageLocksByNumber = useMemo(() => {
    const byId = new Map(pages.map((p) => [p.id, p.pageNumber] as const))
    const m = new Map<number, { clientId: string; name: string; color: string }>()
    for (const l of locks) {
      if (identity && l.clientId === identity.clientId) continue
      const n = byId.get(l.pageId)
      if (n != null && !m.has(n)) m.set(n, { clientId: l.clientId, name: l.name, color: l.color })
    }
    return m
  }, [locks, pages, identity])

  /** Everyone watching now, self included (unique browsers) — the eye tag counts watchers, not others. */
  const watcherCount = useMemo(() => {
    const seen = new Set<string>()
    for (const u of users) seen.add(u.clientId)
    if (identity) seen.add(identity.clientId)
    return seen.size
  }, [users, identity])

  /** Other readers currently around (self excluded) for the presence pill. */
  const otherUsers = useMemo(() => {
    if (!identity) return []
    const seen = new Set<string>()
    return users.filter((u) => {
      if (u.clientId === identity.clientId || seen.has(u.clientId)) return false
      seen.add(u.clientId)
      return true
    })
  }, [users, identity])

  const maxPage = useMemo(() => {
    const numbered = pages.filter((p) => p.pageNumber > 0)
    return numbered.length ? Math.max(...numbered.map((p) => p.pageNumber)) : 0
  }, [pages])

  const refreshNotes = useCallback(async () => {
    if (!book) return
    try {
      const r = await fetchWithTimeout(`/api/notes?bookId=${book.id}`, undefined, 10000)
      if (r.ok) {
        const d = await r.json()
        setAllNotes(d.notes ?? [])
      }
    } catch { /* keep old counts */ }
  }, [book])

  // ---------- reading progress: store (debounced) ----------
  const saveProgress = useCallback((page: number) => {
    lastSavedPage.current = page
    if (progressTimer.current) clearTimeout(progressTimer.current)
    progressTimer.current = setTimeout(() => {
      progressTimer.current = null
      fetchWithTimeout('/api/book/progress', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: lastSavedPage.current }),
      }, 8000)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          // Adopt the server clamp (Wave D) so the local bookmark never
          // points past a swept end.
          if (d && typeof d.page === 'number') lastSavedPage.current = d.page
        })
        .catch(() => {})
    }, 900)
  }, [])

  const flushProgress = useCallback(() => {
    if (!progressTimer.current) return
    clearTimeout(progressTimer.current)
    progressTimer.current = null
    fetchWithTimeout('/api/book/progress', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: lastSavedPage.current }),
    }, 8000)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && typeof d.page === 'number') lastSavedPage.current = d.page
      })
      .catch(() => {})
  }, [])

  const phaseRef = useRef<StagePhase>(phase)
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // ---------- reading zoom ----------
  const toggleZoom = useCallback(() => {
    if (phaseRef.current !== 'reading') return
    const next = !zoomed
    setZoomed(next)
    stageRef.current?.setZoom(next)
  }, [zoomed])

  const lastSyncToast = useRef(0)

  // ---------- writable pages ----------
  /**
   * After any shrink (remove / sweep / restore), pull the reader back inside
   * the book when the current display points past the end. Shared by
   * removePage and sweepEmptyPages so neither can strand a ghost number.
   * (Declared before savePage: savePage's 404 path uses it.)
   */
  const correctDisplayAfterShrink = useCallback((latestPages: PageData[], atDisplay: Display) => {
    if (atDisplay.right <= 0) return
    const numbered = latestPages.filter((p) => p.pageNumber > 0)
    const newMax = numbered.length ? Math.max(...numbered.map((p) => p.pageNumber)) : 0
    if (newMax <= 0) {
      requestAnimationFrame(() => stageRef.current?.goToPage(0, { fast: true }))
      return
    }
    // Display may show at most the trailing blank (newMax + 1).
    if (atDisplay.right > newMax + 1) {
      requestAnimationFrame(() => stageRef.current?.goToPage(newMax + 1, { fast: true }))
    } else if (atDisplay.right > newMax && (atDisplay.left >= newMax || atDisplay.left < 0)) {
      requestAnimationFrame(() => stageRef.current?.goToPage(newMax, { fast: true }))
    }
  }, [])

  /**
   * Autosaved words from the ruled paper (PageFace already debounced).
   * Last-writer-wins locally: the screen always shows the newest keystrokes.
   * The draft stays in pendingEdits until a PATCH succeeds, so a server list
   * landing mid-flight can never wipe it (and a failed save never reverts to
   * a stale snapshot that would eat newer typing).
   */
  const savePage = useCallback((pageId: string, patch: { content?: string; title?: string }) => {
    const prior = pendingEdits.current.get(pageId)
    pendingEdits.current.set(pageId, { ...prior, ...patch })
    setPages((ps) => ps.map((p) => (p.id === pageId ? { ...p, ...patch } : p)))
    // NOTE: no client token is ever sent (a NEXT_PUBLIC_* secret would ship
    // in the JS bundle). If ADMIN_TOKEN is ever configured server-side, all
    // calls must go through a central authed fetch wrapper first.
    fetchWithTimeout(`/api/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // Locks are advisory per writer: the server 423s foreign-held pages.
      body: JSON.stringify(identity ? { ...patch, clientId: identity.clientId } : patch),
    })
      .then((res) => {
        if (res.ok) {
          pendingEdits.current.delete(pageId)
          const now = Date.now()
          if (now - lastSyncToast.current > 15000) {
            lastSyncToast.current = now
            toast({
              title: 'Synced to Database',
              description: 'Page contents saved and replicated safely.',
              className: 'toast-ink',
            })
          }
          return
        }
        if (res.status === 423) {
          // Someone else holds the lease: keep the draft on screen and offer
          // to move it to a fresh page instead of silently losing the race.
          res
            .json()
            .catch(() => ({}))
            .then((d: any) => {
              const holder = d?.holder
              const page = pagesRef.current.find((p) => p.id === pageId)
              setOverflow({
                pageId,
                pageNumber: page?.pageNumber ?? 0,
                holder: {
                  name: String(holder?.name ?? 'Someone'),
                  color: String(holder?.color ?? '#d9a93f'),
                  clientId: String(holder?.clientId ?? ''),
                },
              })
              toast({
                title: `${String(holder?.name ?? 'Someone')} is writing here`,
                description: 'Your words are kept — move them to a fresh page.',
                className: 'toast-ink',
              })
            })
          return
        }
        if (res.status === 404) {
          // Gone server-side: drop the draft and reconcile with the server.
          pendingEdits.current.delete(pageId)
          fetchWithTimeout('/api/book', undefined, 10000)
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d?.pages) {
                applyServerPages(d.pages)
                correctDisplayAfterShrink(d.pages, displayRef.current)
              }
            })
            .catch(() => {})
        }
        // Otherwise the draft STAYS (overlay keeps it on screen + protects
        // it from the sweeper) and the next autosave retries it.
        toast({
          title: 'Save failed',
          description:
            res.status === 404
              ? 'That page no longer exists on the server. Reloading is safest.'
              : res.status === 429
                ? 'Saving too fast — paused briefly. Your words are still on the page.'
                : 'Could not reach the database. Your edit was kept on screen.',
          variant: 'destructive',
        })
      })
      .catch(() => {
        // Offline/timeout: draft stays pending; next autosave retries.
        toast({
          title: 'Offline — edit kept locally',
          description: 'Reconnect and keep writing; the next autosave will retry.',
          variant: 'destructive',
        })
      })
  }, [toast, applyServerPages, correctDisplayAfterShrink, identity])

  /** Navigate the stage to a page, waiting out any animation still running
   *  (the stage also queues a pending action, but a short retry makes the
   *  trip bullet-proof when several flips overlap). */
  const navigateToPage = useCallback((pageNumber: number) => {
    let tries = 0
    const attempt = () => {
      const stage = stageRef.current
      if (!stage) return
      if (!stage.isBusy() || tries >= 24) {
        stage.goToPage(pageNumber)
        return
      }
      tries += 1
      setTimeout(attempt, 125)
    }
    requestAnimationFrame(attempt)
  }, [])

  /** Create a page — appended at the end, or inserted after `afterPageNumber`.
   *  If `afterPageNumber` is passed as the number of a blank page that does
   *  not exist yet (e.g. beginning trailing page 3), we insert after the
   *  preceding page (page 2) so the new page occupies that exact number.
   *  A second press within a beat of a creation is ignored: rapid clicking
   *  must mint exactly one page, not a fan of blanks. */
  const createPage = useCallback(async (afterPageNumber?: number) => {
    if (!book) return null
    // Never swallow taps silently (mobile "Begin" felt dead on slow networks).
    if (creatingPage.current) {
      toast({ title: 'Still making that page…', description: 'Give it a moment — one tap is enough.', className: 'toast-ink' })
      return null
    }
    if (Date.now() - lastCreateAt.current < 900) return null
    creatingPage.current = true
    lastCreateAt.current = Date.now()

    // When targeting a page position that does not exist yet (like the trailing blank page),
    // insert after the preceding page so the new sheet takes that exact number.
    let targetAfter = afterPageNumber
    if (typeof targetAfter === 'number' && targetAfter > 0) {
      const pageExists = pagesRef.current.some((p) => p.pageNumber === targetAfter)
      if (!pageExists) {
        targetAfter = Math.max(0, targetAfter - 1)
      }
    }

    // One key per intent (Wave D): a retry tap within 10s of a failure at the
    // same spot reuses the key so the server replays instead of twinning.
    // Anything later is a new intent with a fresh key.
    const lastFail = createFailKey.current
    const idemKey =
      lastFail &&
      Date.now() - lastFail.at < 10_000 &&
      lastFail.after === (targetAfter ?? null)
        ? lastFail.key
        : typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      // Hard timeout: a hung POST must never wedge creatingPage forever (mobile stall).
      const res = await fetchWithTimeout('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-idempotency-key': idemKey },
        body: JSON.stringify({ bookId: book.id, afterPageNumber: targetAfter }),
      })
      if (!res.ok) {
        // Don't arm the debounce on failure — an immediate retry must work (M-5).
        lastCreateAt.current = 0
        if (res.status === 429) {
          toast({ title: 'Slow down', description: 'Too many new pages — wait a moment.', className: 'toast-ink' })
        } else {
          throw new Error(`pages API ${res.status}`)
        }
        return null
      }
      const d = await res.json()
      createFailKey.current = null
      applyServerPages(d.pages)
      setFocusPageId(d.page.id)
      setTimeout(() => setFocusPageId(null), 400)
      freshPages.current.set(d.page.id, Date.now())
      navigateToPage(d.page.pageNumber)
      // A renumber shifts margin notes: refresh counts (Wave D).
      void refreshNotes()
      toast({
        title: `Page ${d.page.pageNumber} added`,
        description: 'A fresh sheet, right where you were reading. One character keeps it forever.',
        className: 'toast-ink',
      })
      return d.page as PageData
    } catch (e) {
      console.error('createPage failed:', e)
      // Debounce disarmed so the retry tap works immediately. Keep the key so
      // the retry replays instead of twinning (server binds key to body).
      lastCreateAt.current = 0
      createFailKey.current = { key: idemKey, after: targetAfter ?? null, at: Date.now() }
      toast({
        title: 'The page could not be made',
        description: isTimeoutError(e)
          ? 'The request timed out — tap again to retry (no duplicate will be made).'
          : 'The books cluster did not answer. Try again in a moment.',
        className: 'toast-ink',
      })
      return null
    } finally {
      creatingPage.current = false
    }
  }, [book, navigateToPage, toast, refreshNotes])

  /**
   * Overflow: move my blocked draft onto a fresh page after the contested
   * one. Placed after createPage/savePage: its dep array reads both at
   * render time. The fresh page is mine (grace + lease on first keystroke).
   */
  const moveOverflowToFreshPage = useCallback(async () => {
    if (!overflow) return
    const { pageId, pageNumber } = overflow
    const cur = pagesRef.current.find((p) => p.id === pageId)
    const draft = pendingEdits.current.get(pageId)
    const content = draft?.content ?? cur?.content ?? ''
    const title = draft?.title ?? cur?.title ?? ''
    setOverflow(null)
    if (!content.trim() && !title.trim()) {
      toast({ title: 'Nothing to move', description: 'The draft was empty.', className: 'toast-ink' })
      return
    }
    const fresh = await createPage(pageNumber > 0 ? pageNumber : undefined)
    if (!fresh) return
    pendingEdits.current.delete(pageId)
    savePage(fresh.id, { content, title })
    toast({
      title: `Moved to page ${fresh.pageNumber}`,
      description: 'Your words, kept safe on a fresh sheet.',
      className: 'toast-ink',
    })
  }, [overflow, createPage, savePage, toast])

  /** Pin / unpin a page: pinned pages are kept even when they are empty. */
  const togglePagePin = useCallback((page: PageData) => {
    const pinned = !page.pinned
    setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, pinned } : p)))
    fetchWithTimeout(`/api/pages/${page.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned }),
    })
      .then((res) => {
        if (!res.ok) {
          setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, pinned: page.pinned } : p)))
        }
      })
      .catch(() => {
        setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, pinned: page.pinned } : p)))
      })
  }, [])

  /** Remove a page (the confirmation is already answered by the caller). */
  const removePage = useCallback(async (page: PageData) => {
    try {
      // Hard timeout: a hung DELETE must not wedge the dialog open (mobile stall).
      const res = await fetchWithTimeout(`/api/pages/${page.id}`, { method: 'DELETE' })
      if (!res.ok) {
        setConfirmPage(null)
        toast({
          title: res.status === 404 ? 'Page already gone' : 'Could not remove page',
          description:
            res.status === 404
              ? 'It was already removed elsewhere. Refreshing the list.'
              : 'The database did not answer. Nothing was removed.',
          variant: 'destructive',
        })
        if (res.status === 404) {
          try {
            const r = await fetchWithTimeout('/api/book', undefined, 10000)
            if (r.ok) {
              const d = await r.json()
              if (d.pages) {
                applyServerPages(d.pages)
                correctDisplayAfterShrink(d.pages, displayRef.current)
              }
            }
          } catch { /* keep current */ }
        }
        return
      }
      const d = await res.json()
      applyServerPages(d.pages)
      setConfirmPage(null)
      correctDisplayAfterShrink(d.pages, displayRef.current)
      // Renumber shifts margin notes: refresh counts (Wave D).
      void refreshNotes()
      toast({
        title: `Page ${page.pageNumber} removed`,
        description: 'The pages after it shifted up to close the gap.',
        className: 'toast-ink',
      })
    } catch (e) {
      // Offline/timeout: leave the page in place, close the dialog, say so.
      setConfirmPage(null)
      toast({
        title: 'Could not remove page',
        description: isTimeoutError(e)
          ? 'The request timed out. Nothing was removed — try again.'
          : 'You look offline. Nothing was removed.',
        variant: 'destructive',
      })
    }
  }, [toast, correctDisplayAfterShrink, refreshNotes])

  /** Empty unpinned pages are removed on their own once the reader has moved
   *  on. A page with even one visible character — a dot, a comma, a title —
   *  is never touched (markup residue like "<p><br></p>" counts as blank).
   *  Freshly created pages get a grace minute: the reader may still
   *  be wandering before they write. Deletions run one after another and the
   *  server's renumbered list is applied after each, so client and books
   *  cluster always agree on the numbering. The server re-checks blankness
   *  too (?sweep=1), so a stale client can never nuke real content. */
  const sweepEmptyPages = useCallback((keepVisible: Set<number>) => {
    const now = Date.now()
    freshPages.current.forEach((t, id) => {
      if (now - t > 60_000) freshPages.current.delete(id)
    })
    const doomed = pagesRef.current.filter(
      (p) =>
        p.pageNumber > 0 &&
        !p.pinned &&
        isBlankHtml(p.content) &&
        (p.title ?? '').trim().length === 0 &&
        !keepVisible.has(p.pageNumber) &&
        !freshPages.current.has(p.id),
    )
    if (doomed.length === 0) return
    // M-6 fix: never locally fabricate numbering. On network failure keep the
    // page and retry on the next sweep/online event; guard overlapping sweeps.
    if (sweepRunning.current) return
    sweepRunning.current = true
    const run = async () => {
      let latest: PageData[] | null = null
      try {
        for (const p of doomed) {
          try {
            // Re-validate right before each DELETE: the snapshot may be stale
            // (user typed, pinned, or navigated since). Visibility is read
            // live per iteration (N3) so a mid-sweep flip can't doom the
            // page the reader just landed on. Never remove a page that is
            // no longer blank, pinned, fresh, or visible.
            const cur = pagesRef.current.find((q) => q.id === p.id)
            const vis = displayRef.current
            const visibleLive = new Set([vis.left, vis.right].filter((n) => n > 0))
            if (
              !cur ||
              cur.pinned ||
              !isBlankHtml(cur.content) ||
              (cur.title ?? '').trim().length !== 0 ||
              visibleLive.has(cur.pageNumber) ||
              freshPages.current.has(cur.id)
            ) {
              freshPages.current.delete(p.id)
              continue
            }
            const res = await fetchWithTimeout(`/api/pages/${p.id}?sweep=1`, { method: 'DELETE' }, 10000)
            if (res.ok) {
              const d = await res.json()
              if (d.pages) {
                latest = d.pages
                applyServerPages(d.pages)
                freshPages.current.delete(p.id)
                continue
              }
            } else if (res.status === 404) {
              // Already gone server-side: adopt server list on next refresh.
              freshPages.current.delete(p.id)
              continue
            }
            // Non-OK (offline/500): keep the page, retry later.
            freshPages.current.delete(p.id)
          } catch {
            // Offline/timeout: keep the page locally, retry on next sweep.
            freshPages.current.delete(p.id)
          }
        }
      } finally {
        sweepRunning.current = false
      }
      // A renumbering sweep can strand the display past the end (ghost
      // "Begin page N+2") — pull back inside the shrunken book.
      if (latest) {
        correctDisplayAfterShrink(latest, displayRef.current)
        // Renumber shifts margin notes: refresh counts (Wave D).
        void refreshNotes()
      }
    }
    void run()
  }, [correctDisplayAfterShrink, refreshNotes])

  // settle sweep: a beat after the reader lands on a spread, blank pages
  // they have left behind quietly fall out of the book
  useEffect(() => {
    if (phase !== 'reading') return
    const t = setTimeout(() => {
      sweepEmptyPages(new Set([display.left, display.right].filter((n) => n > 0)))
    }, 1500)
    return () => clearTimeout(t)
  }, [display, phase, sweepEmptyPages])

  // ---------- stage callbacks ----------
  const handleOpenStart = useCallback(() => setPhase('opening'), [])
  const handleOpened = useCallback(() => {
    setPhase('reading')
    // retrieve: riffle back to the page the reader left off on
    const target = Math.min(lastSavedPage.current, maxPage || 1)
    if (target > 1) {
      requestAnimationFrame(() => stageRef.current?.goToPage(target, { fast: true }))
    }
  }, [maxPage])
  const handleClosed = useCallback(() => {
    setPhase('front')
    setZoomed(false)
    setFocusPageId(null)
    // blank pages never survive a close: sweep all of them now that the
    // riffle-home animation has finished
    setTimeout(() => sweepEmptyPages(new Set()), 60)
  }, [sweepEmptyPages])
  const handleDisplayChange = useCallback((d: Display) => {
    setDisplay(d)
    if (d.right > 0 && phaseRef.current === 'reading') {
      saveProgress(Math.min(d.right, maxPage || d.right))
    }
  }, [saveProgress, maxPage])
  const handleOpenNotes = useCallback((pageNumber: number) => {
    setNotesTarget(pageNumber)
    setNotesPanelOpen(true)
  }, [])

  // ---------- open with a real read of both clusters ----------
  const openBook = useCallback(async () => {
    if (phaseRef.current !== 'front' || !book || loadState) return
    setLoadState({ stage: 'reading' })
    try {
      localStorage.setItem('libris_last_opened', String(Date.now()))
      setLastOpened(Date.now())
    } catch {}
    const t0 = performance.now()
    try {
      const [bookRes, notesRes, boardRes] = await Promise.all([
        fetchWithTimeout('/api/book', undefined, 12000),
        fetchWithTimeout(`/api/notes?bookId=${book.id}`, undefined, 12000),
        fetchWithTimeout('/api/board', undefined, 12000),
      ])
      if (!bookRes.ok) throw new Error('book API failed')
      const bd = await bookRes.json()
      const nd = notesRes.ok ? await notesRes.json() : { notes: [] }
      const boardd = boardRes.ok ? await boardRes.json() : { notes: [] }

      setBook(bd.book)
      applyServerPages(bd.pages)
      setAllNotes(nd.notes ?? [])
      lastSavedPage.current = Math.min(bd.book?.lastPage ?? 1, 99_999)

      const arranged: LoadState = {
        stage: 'arranged',
        pages: (bd.pages as PageData[]).filter((p) => p.pageNumber > 0).length,
        notes: (nd.notes ?? []).length,
        board: (boardd.notes ?? []).length,
      }
      // let the read be perceived, then show the arrangement, then open
      const elapsed = performance.now() - t0
      if (elapsed < 620) await sleep(620 - elapsed)
      setLoadState(arranged)
      await sleep(560)
      setLoadState(null)
      stageRef.current?.open()
    } catch (e) {
      console.error('openBook failed:', e)
      setLoadState(null)
      setDbError(
        isTimeoutError(e)
          ? 'The clusters are taking too long (slow network?). Check your connection and try again.'
          : 'Could not read the clusters before opening. Check that both TiDB clusters are running.'
      )
    }
  }, [book, loadState])

  const closeBook = useCallback(() => {
    if (phase !== 'reading') return
    flushProgress()
    if (zoomed) {
      setZoomed(false)
      stageRef.current?.setZoom(false)
    }
    setNotesPanelOpen(false)
    setIndexOpen(false)
    setConfirmPage(null)
    setPhase('closing')
    stageRef.current?.close()
  }, [phase, zoomed, flushProgress])

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (boardOpen) {
        // the board owns every key while it is open — its own Escape peels
        // editor → day filter → board, so this must not race it
        return
      }
      if (confirmPage) {
        if (e.key === 'Escape') setConfirmPage(null)
        return
      }
      if (e.key === 'Escape') {
        const el = document.activeElement
        if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          el.blur()
          return
        }
        if (indexOpen) { setIndexOpen(false); return }
        if (notesPanelOpen) { setNotesPanelOpen(false); return }
        if (zoomed) { toggleZoom(); return }
        if (phase === 'reading') {
          closeBook()
          return
        }
      }
      const el = document.activeElement
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      if (e.key === 'i' || e.key === 'I') {
        if (phase === 'reading') {
          if (indexOpen) setIndexOpen(false)
          else {
            setNotesPanelOpen(false) // the panels share the reading spot
            setIndexOpen(true)
          }
        }
        return
      }
      if ((e.key === 'n' || e.key === 'N') && phase === 'reading' && !zoomed) {
        createPage(display.right > 0 ? display.right : undefined)
        return
      }
      if (phase !== 'reading' || notesPanelOpen) {
        if ((e.key === 'z' || e.key === 'Z') && phase === 'reading') toggleZoom()
        return
      }
      if (e.key === 'ArrowRight') stageRef.current?.next()
      if (e.key === 'ArrowLeft') stageRef.current?.prev()
      if (e.key === 'z' || e.key === 'Z') toggleZoom()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, boardOpen, notesPanelOpen, indexOpen, confirmPage, toggleZoom, createPage, display.right, zoomed, closeBook])

  // ---------- refresh pages (the board can write pages too) ----------
  const refreshPages = useCallback(async () => {
    try {
      const r = await fetchWithTimeout('/api/book', undefined, 10000)
      if (r.ok) {
        const d = await r.json()
        if (d.pages) applyServerPages(d.pages)
      }
    } catch { /* keep the current pages */ }
  }, [applyServerPages])

  // ---------- presence: who else is here (Wave 1) ----------
  // Heartbeat doubles as change-detection: the response carries versions +
  // live edit leases. Skipped while hidden (returning tabs re-sync on focus).
  // Placed AFTER refreshPages/refreshNotes: the dep arrays read both at render.
  const beatPresence = useCallback(
    async (lock?: { acquire?: string; release?: string }) => {
      if (!identity || !tabId) return null
      const rightId = pageByNum.get(displayRef.current.right)?.id ?? null
      const active =
        phaseRef.current === 'reading' && Date.now() - lastActivityAt.current < 30_000
      try {
        const res = await fetchWithTimeout(
          '/api/presence',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              clientId: identity.clientId,
              tabId,
              name: identity.name,
              color: identity.color,
              pageId: phaseRef.current === 'reading' ? rightId : null,
              activity: active ? 'editing' : 'viewing',
              ...(lock ? { lock } : {}),
            }),
          },
          10000
        )
        if (!res.ok) return null
        const d = await res.json()
        if (Array.isArray(d.users)) {
          setUsers((prev) => {
            const sig = JSON.stringify(d.users)
            return JSON.stringify(prev) === sig ? prev : d.users
          })
        }
        if (Array.isArray(d.locks)) {
          setLocks((prev) => {
            const sig = JSON.stringify(d.locks)
            return JSON.stringify(prev) === sig ? prev : d.locks
          })
        }
        if (d.versions) {
          const sig = JSON.stringify(d.versions)
          if (versionsRef.current !== sig) {
            versionsRef.current = sig
            void refreshPages()
            void refreshNotes()
          }
        }
        return d as {
          users: PresenceUserView[]
          locks: PageLockView[]
          lockResult?: { acquired: boolean; holder: PageLockView } | null
        }
      } catch {
        return null
      }
    },
    [identity, tabId, pageByNum, refreshPages, refreshNotes]
  )

  useEffect(() => {
    if (!identity) return
    void beatPresence()
    const t = setInterval(() => {
      if (!document.hidden) void beatPresence()
    }, HEARTBEAT_MS)
    const onVisible = () => {
      if (!document.hidden) void beatPresence()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [identity, beatPresence])

  useEffect(() => {
    const markActive = () => {
      lastActivityAt.current = Date.now()
    }
    window.addEventListener('keydown', markActive)
    window.addEventListener('pointerdown', markActive)
    return () => {
      window.removeEventListener('keydown', markActive)
      window.removeEventListener('pointerdown', markActive)
    }
  }, [])

  /** Take the edit lease on a page (idempotent; toasts when held by other). */
  const acquirePageLock = useCallback(
    async (page: PageData) => {
      if (!identity) return
      const d = await beatPresence({ acquire: page.id })
      const r = d?.lockResult
      if (r && !r.acquired) {
        toast({
          title: `${r.holder.name} is writing here`,
          description: 'The page is read-only for you until they finish — or start a fresh page.',
          className: 'toast-ink',
        })
      } else if (r?.acquired) {
        setMyLockedPages((prev) => (prev.includes(page.id) ? prev : [...prev, page.id]))
      }
    },
    [identity, beatPresence, toast]
  )

  /** Release my lease (best-effort; expiry backstops crashes). */
  const releasePageLock = useCallback(
    (pageId: string) => {
      setMyLockedPages((prev) => prev.filter((id) => id !== pageId))
      if (!identity) return
      void beatPresence({ release: pageId })
    },
    [identity, beatPresence]
  )

  // Leaving a spread releases leases that are no longer visible, so nobody
  // waits on a ghost. Vanished pages release too.
  useEffect(() => {
    if (myLockedPages.length === 0) return
    const visible = new Set(
      pagesRef.current
        .filter((p) => p.pageNumber === display.left || p.pageNumber === display.right)
        .map((p) => p.id)
    )
    const stale = myLockedPages.filter((id) => {
      const stillExists = pagesRef.current.some((p) => p.id === id)
      return !stillExists || !visible.has(id)
    })
    if (stale.length === 0) return
    setMyLockedPages((prev) => prev.filter((id) => !stale.includes(id)))
    if (identity) {
      for (const id of stale) void beatPresence({ release: id })
    }
  }, [display, pages, myLockedPages, identity, beatPresence])

  // ---------- search targets ----------
  const goToPage = useCallback((pageNumber: number) => {
    stageRef.current?.goToPage(pageNumber)
  }, [])

  // ---------- export: the whole book as a plain text file ----------
  const exportBook = useCallback(() => {
    const lines: string[] = []
    lines.push(book?.title ?? 'Libris')
    if (book?.subtitle) lines.push(book.subtitle)
    if (book?.author) lines.push(`by ${book.author}`)
    lines.push('')
    lines.push(`Exported ${new Date().toLocaleDateString()} · ${maxPage} page${maxPage === 1 ? '' : 's'}`)
    lines.push('')
    pages
      .filter((p) => p.pageNumber > 0)
      .forEach((p) => {
        lines.push(`— Page ${p.pageNumber} —`)
        const title = (p.title ?? '').trim()
        const content = (p.content ?? '').replace(/<[^>]*>/g, '').trim()
        if (title) lines.push(title)
        if (content) lines.push(content)
        else if (!title) lines.push('(kept blank)')
        lines.push('')
      })
    try {
      const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'libris.txt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      toast({
        title: 'The book is yours',
        description: `${maxPage} page${maxPage === 1 ? '' : 's'} written to libris.txt.`,
        className: 'toast-ink',
      })
    } catch {
      toast({ title: 'Export failed', description: 'The browser refused the download.', className: 'toast-ink' })
    }
  }, [book, pages, maxPage, toast])

  const openNoteFromSearch = useCallback((note: PageNoteData) => {
    goToPage(note.pageNumber)
    setNotesTarget(note.pageNumber)
    setNotesPanelOpen(true)
  }, [goToPage])

  // notes panel target page
  const notesPage = useMemo(() => {
    if (notesTarget != null) return pageByNum.get(notesTarget) ?? null
    return pageByNum.get(display.right) ?? null
  }, [notesTarget, display.right, pageByNum])

  /** Pager label; the trailing blank is the next page waiting to be begun. */
  const pagerLabel = useMemo(() => {
    if (maxPage <= 0) return ''
    const { left, right } = display
    if (right > maxPage) {
      return left > 0 && left <= maxPage
        ? `Pages ${left}–${maxPage} of ${maxPage} · new page ahead`
        : `New page ahead · ${maxPage} written`
    }
    return left > 0 ? `Pages ${left}–${right} of ${maxPage}` : `Page ${right} of ${maxPage}`
  }, [display, maxPage])

  const toolbarVisible = phase === 'reading' || phase === 'closing'
  const frontTextVisible = phase === 'front' && !loadState

  return (
    <div className={`app-root app-root--${phase}`}>
      {/* cold ink room */}
      <div className="app-backdrop" aria-hidden="true">
        <div className="app-backdrop-glow" />
      </div>
      <div className="app-vignette" aria-hidden="true" />
      <div className="app-dust" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <span key={i} style={{ animationDelay: `${i * 2.3}s`, left: `${10 + i * 11}%` }} />
        ))}
      </div>
      <div className="app-grain" aria-hidden="true" />

      <BookStage
        ref={stageRef}
        pages={pages}
        phase={phase}
        zoomed={zoomed}
        bookTitle={book?.title ?? 'Libris'}
        bookSubtitle={book?.subtitle ?? 'A Manual for Writing Inside Books'}
        bookAuthor={book?.author ?? ''}
        noteCounts={noteCounts}
        onOpenStart={handleOpenStart}
        onOpened={handleOpened}
        onClosed={handleClosed}
        onDisplayChange={handleDisplayChange}
        onOpenNotes={handleOpenNotes}
        onCreatePage={createPage}
        onSavePage={savePage}
        onTogglePagePin={togglePagePin}
        onDeletePage={(p) => setConfirmPage(p)}
        focusId={focusPageId}
        identity={identity}
        pageLocks={pageLocksByNumber}
        onLockAcquire={acquirePageLock}
        onLockRelease={releasePageLock}
      />

      {/* ---------- front page overlay ---------- */}
      <div
        className={`front-overlay ${frontTextVisible ? 'front-overlay--visible' : ''}`}
        aria-hidden={!frontTextVisible}
        inert={!frontTextVisible}
      >
        <div className="front-brand front-anim" style={{ ['--d' as string]: '60ms' }}>
          <img src="/logo.svg" alt="Libris logo" className="front-brand-icon" width={30} height={30} />
          <span className="front-brand-name">Libris</span>
        </div>

        <div className="front-intro">
          <span className="front-kicker front-anim" style={{ ['--d' as string]: '170ms' }}>
            The reading room
          </span>
          <h1 className="front-title front-anim" style={{ ['--d' as string]: '260ms' }}>
            A book you can<br />
            <em>write inside.</em>
          </h1>
          <p className="front-sub front-anim" style={{ ['--d' as string]: '380ms' }}>
            Turn real pages, write on the ruled paper, add pages as you go.
            Search every sentence, keep notes exactly where your thoughts
            happened, and trust them to stay.
          </p>
          <div className="front-cta-row front-anim" style={{ ['--d' as string]: '500ms' }}>
            <button
              type="button"
              className="open-book-cta"
              onClick={openBook}
              disabled={!book}
            >
              <BookOpen size={15} strokeWidth={1.8} aria-hidden="true" />
              {book ? 'Open the book' : 'Loading'}
              <ArrowRight size={14} strokeWidth={2} className="cta-arrow" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="front-alt"
              onClick={() => setBoardOpen(true)}
            >
              <StickyNote size={15} strokeWidth={1.7} aria-hidden="true" />
              Notes board
            </button>
          </div>
          <p className="front-meta front-anim" style={{ ['--d' as string]: '620ms' }}>
            {maxPage > 0 && (
              <>
                <span>{maxPage} page{maxPage === 1 ? '' : 's'}</span>
                <span className="meta-sep" aria-hidden="true">·</span>
              </>
            )}
            <span>{allNotes.length + boardCount} note{allNotes.length + boardCount === 1 ? '' : 's'}</span>
            <span className="meta-sep" aria-hidden="true">·</span>
            <Link
              href="/health"
              className="hover:underline transition-colors"
              style={{ color: '#22c55e', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '3px' }}
              title={dbOk === false ? 'Database unreachable' : dbOk === null ? 'Connecting…' : 'All systems operational'}
            >
              <span className={`db-dot ${dbOk === false ? 'db-dot--down' : dbOk === null ? 'db-dot--wait' : 'db-dot--ok'}`} aria-hidden="true" />
              Health
            </Link>
            <span className="meta-sep" aria-hidden="true">·</span>
            <Link
              href="/storage"
              className="hover:underline transition-colors"
              style={{ color: '#f0d17c', textDecoration: 'none' }}
            >
              Storage
            </Link>
          </p>
        </div>

        {/* Floating last-opened pill, pinned to the book's bottom-right corner (dark theme) */}
        {lastOpened !== null && (
          <div
            ref={openedPillRef}
            className="front-anim"
            style={
              {
                ['--d' as string]: '700ms',
                position: 'absolute',
                right: 'clamp(12px, 13vw, 250px)',
                bottom: 'clamp(12px, 8vh, 84px)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 16px',
                borderRadius: 999,
                background: 'rgba(12, 14, 18, 0.88)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: '#e8e4dc',
                fontSize: 12.5,
                fontWeight: 600,
                letterSpacing: '0.02em',
                boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
                whiteSpace: 'nowrap',
                backdropFilter: 'blur(8px)',
                pointerEvents: 'auto',
              } as React.CSSProperties
            }
            title={`Last opened ${new Date(lastOpened).toLocaleString()}`}
          >
            <Sparkles size={12} strokeWidth={2.2} aria-hidden="true" style={{ color: '#e07856' }} />
            Last opened {new Date(lastOpened).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
        )}
      </div>

      {/* ---------- reading-the-clusters veil (before the book opens) ---------- */}
      {loadState && (
        <div className="load-veil" role="status" aria-live="polite">
          <div className="load-card">
            <Loader2 className="spin" size={22} strokeWidth={2} aria-hidden="true" />
            <div className="load-title">
              {loadState.stage === 'reading' ? 'Reading the clusters' : 'Arranged'}
            </div>
            <div className="load-sub">
              {loadState.stage === 'reading'
                ? 'books cluster · notes cluster · reading position'
                : `${loadState.pages ?? 0} pages · ${loadState.notes ?? 0} margin notes · ${loadState.board ?? 0} board notes, placed as you left them`}
            </div>
            <div className="load-bar" aria-hidden="true">
              <span className={loadState.stage === 'arranged' ? 'load-bar--full' : ''} />
            </div>
          </div>
        </div>
      )}

      {dbError && (
        <div className="db-error" role="alert">
          <Database size={15} strokeWidth={2} aria-hidden="true" />
          {dbError}
        </div>
      )}

      {/* ---------- live watchers side tag (eye + count, draggable) ---------- */}
      {identity && (
        <div
          ref={watchTagRef}
          role="status"
          aria-label={`${watcherCount} watching now`}
          title={
            otherUsers.length === 0
              ? 'You are watching now · drag me anywhere'
              : `Watching now (${watcherCount}):\n` +
                (identity && !otherUsers.some((u) => u.clientId === identity.clientId) ? 'you\n' : '') +
                otherUsers.map((u) => `${u.name}${u.activity === 'editing' ? ' — writing' : ''}`).join('\n')
          }
          onPointerDown={onWatchTagDown}
          style={{
            position: 'fixed',
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: 60,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '8px 9px 8px 10px',
            borderRadius: '0 10px 10px 0',
            background: 'rgba(10, 12, 16, 0.82)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderLeft: 'none',
            color: '#e8e4dc',
            fontSize: 12,
            fontWeight: 600,
            backdropFilter: 'blur(8px)',
            cursor: 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          <Eye size={14} strokeWidth={2} aria-hidden="true" style={{ color: '#f0d17c', pointerEvents: 'none' }} />
          <span style={{ pointerEvents: 'none' }}>{watcherCount}</span>
        </div>
      )}

      {/* ---------- reading toolbar ---------- */}
      <div className={`toolbar ${toolbarVisible ? 'toolbar--visible' : ''}`}>
        <div className="toolbar-row">
          <button
            type="button"
            className="tool-btn tool-btn--accent"
            onClick={() => setBoardOpen(true)}
            aria-label="Open the notes board"
            title="Notes board"
          >
            <StickyNote size={16} strokeWidth={1.8} />
          </button>

          <div className="toolbar-search">
            <SearchBar pages={pages} onGoToPage={goToPage} onOpenNote={openNoteFromSearch} />
          </div>

          <span className="tool-sep" aria-hidden="true" />

          <button
            type="button"
            className={`tool-btn ${indexOpen ? 'tool-btn--on' : ''}`}
            disabled={phase !== 'reading'}
            onClick={() => {
              if (indexOpen) {
                setIndexOpen(false)
                return
              }
              setNotesPanelOpen(false) // the panels share the reading spot
              setIndexOpen(true)
            }}
            aria-pressed={indexOpen}
            aria-label="Index of pages"
            title="Index — every page at a glance (I)"
          >
            <BookMarked size={16} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            className="tool-btn"
            disabled={zoomed || phase !== 'reading'}
            onClick={() => createPage(display.right > 0 ? display.right : undefined)}
            aria-label="New page after this one"
            title="New page after this one (N)"
          >
            <FilePlus2 size={16} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            className="tool-btn"
            onClick={exportBook}
            aria-label="Export the book as a text file"
            title="Export the book — every page, as text"
          >
            <Download size={16} strokeWidth={1.8} />
          </button>

          {otherUsers.length > 0 && (
            <span
              className="presence-pill"
              role="status"
              title={otherUsers
                .map((u) => `${u.name}${u.pageId ? ` — ${u.activity}` : ''}`)
                .join('\n')}
              aria-label={`${otherUsers.length} other reader${otherUsers.length === 1 ? '' : 's'} here`}
            >
              {otherUsers.slice(0, 5).map((u) => (
                <span
                  key={u.clientId}
                  className="presence-dot"
                  style={{ backgroundColor: u.color }}
                  aria-hidden="true"
                />
              ))}
              {otherUsers.length}
            </span>
          )}

          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              setNotesTarget(null)
              setIndexOpen(false) // the panels share the reading spot
              setNotesPanelOpen(true)
            }}
            aria-label="Margin notes for this page"
            title="Margin notes"
          >
            <NotebookPen size={16} strokeWidth={1.8} />
          </button>

          <button
            type="button"
            className={`tool-btn ${zoomed ? 'tool-btn--on' : ''}`}
            onClick={toggleZoom}
            aria-pressed={zoomed}
            aria-label={zoomed ? 'Turn reading zoom off' : 'Zoom to read (editing paused)'}
            title={zoomed ? 'Zoom out — writing returns (Z)' : 'Zoom to read precisely (editing paused) · Z'}
          >
            {zoomed ? <ZoomOut size={16} strokeWidth={2} /> : <ZoomIn size={16} strokeWidth={2} />}
          </button>

          <div className="relative inline-block">
            <button
              type="button"
              className={`tool-btn ${fontPickerOpen ? 'tool-btn--on' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setFontPickerOpen((prev) => !prev)
              }}
              aria-label="Change handwriting font"
              title="Handwriting font style"
            >
              <Type size={16} strokeWidth={1.8} />
            </button>
            {fontPickerOpen && (
              <div
                className="font-picker-dropdown"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="font-picker-header">Handwriting Font</div>
                {HANDWRITING_FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`font-picker-item ${activeFont === f.id ? 'font-picker-item--active' : ''}`}
                    style={{ fontFamily: `'${f.id}', cursive` }}
                    onClick={() => {
                      selectHandwritingFont(f.id)
                      setFontPickerOpen(false)
                    }}
                  >
                    <span className="font-picker-name">{f.label}</span>
                    <span className="font-picker-sample">{f.sample}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="tool-sep" aria-hidden="true" />

          <div className="pager">
            <button
              type="button"
              className="tool-btn"
              onClick={() => stageRef.current?.prev()}
              aria-label="Previous page"
              title="Previous page (left arrow)"
            >
              <ChevronLeft size={18} strokeWidth={2} />
            </button>
            <span className="pager-label" aria-live="polite">
              {pagerLabel}
            </span>
            <button
              type="button"
              className="tool-btn"
              onClick={() => stageRef.current?.next()}
              aria-label="Next page"
              title="Next page (right arrow)"
            >
              <ChevronRight size={18} strokeWidth={2} />
            </button>
          </div>

          <span className="tool-sep" aria-hidden="true" />

          <button type="button" className="tool-btn" onClick={closeBook} aria-label="Close the book" title="Close book">
            <X size={17} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* page-turn hint */}
      <div className={`flip-hint ${phase === 'reading' && !notesPanelOpen && !indexOpen ? 'flip-hint--visible' : ''}`} aria-hidden="true">
        {zoomed
          ? 'Zoom is on · drag to pan the page · press Z to zoom out and write again'
          : 'Click page edges or drag to turn · write on the paper · press I for the index'}
      </div>

      {/* ---------- index of pages ---------- */}
      <IndexPanel
        open={indexOpen && phase === 'reading'}
        pages={pages}
        noteCounts={noteCounts}
        currentPage={display.right}
        showFlyleaf={!narrow}
        onClose={() => setIndexOpen(false)}
        onGoToPage={(n) => {
          setIndexOpen(false)
          goToPage(n)
        }}
        onNewPage={() => {
          if (zoomed) return
          setIndexOpen(false)
          createPage(display.right > 0 ? display.right : undefined)
        }}
      />

      {/* ---------- margin notes panel ---------- */}
      <NotesPanel
        open={notesPanelOpen && phase === 'reading'}
        page={notesPage}
        readOnly={zoomed}
        onClose={() => setNotesPanelOpen(false)}
        onNotesChanged={refreshNotes}
      />

      {/* ---------- remove-page confirmation ---------- */}
      {confirmPage && (
        <div
          className="confirm-veil"
          role="dialog"
          aria-modal="true"
          aria-label="Remove this page?"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmPage(null)
          }}
        >
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon" aria-hidden="true">
              <Trash2 size={18} strokeWidth={2} />
            </div>
            <h3 className="confirm-title">Remove page {confirmPage.pageNumber}?</h3>
            <p className="confirm-body">
              {(confirmPage.title ?? '').trim() || (confirmPage.content ?? '').replace(/<[^>]*>/g, '').trim()
                ? `“${((confirmPage.title ?? '').trim() || (confirmPage.content ?? '').replace(/<[^>]*>/g, '').trim()).slice(0, 64)}${((confirmPage.title ?? '').trim() || (confirmPage.content ?? '').replace(/<[^>]*>/g, '').trim()).length > 64 ? '…' : ''}” will be removed.`
                : 'This blank page will be removed.'}
              {' '}The pages after it shift up to close the gap. This cannot be undone.
            </p>
            <div className="confirm-row">
              <button type="button" className="confirm-cancel" onClick={() => setConfirmPage(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="confirm-remove"
                onClick={() => removePage(confirmPage)}
              >
                <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- write-conflict overflow (someone else holds the lease) ---------- */}
      {overflow && (
        <div
          className="confirm-veil"
          role="dialog"
          aria-modal="true"
          aria-label="Someone else is writing here"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOverflow(null)
          }}
        >
          <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
            <div
              className="confirm-icon"
              aria-hidden="true"
              style={{ borderColor: overflow.holder.color, color: overflow.holder.color }}
            >
              <NotebookPen size={18} strokeWidth={2} />
            </div>
            <h3 className="confirm-title">
              {overflow.holder.name} is writing{overflow.pageNumber > 0 ? ` on page ${overflow.pageNumber}` : ''}?
            </h3>
            <p className="confirm-body">
              Your words are safe on screen. Move them onto a fresh page of your
              own, or keep editing here (the next save may still lose the race).
            </p>
            <div className="confirm-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              <button type="button" className="confirm-remove" onClick={moveOverflowToFreshPage}>
                <FilePlus2 size={13} strokeWidth={2} aria-hidden="true" />
                Move my words to a fresh page
              </button>
              <button type="button" className="confirm-cancel" onClick={() => setOverflow(null)}>
                Keep editing here
              </button>
              <button
                type="button"
                className="confirm-cancel"
                style={{ border: 'none', background: 'transparent' }}
                onClick={() => {
                  pendingEdits.current.delete(overflow.pageId)
                  setOverflow(null)
                  void refreshPages()
                }}
              >
                Discard my words
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- identity gate (first visit) ---------- */}
      {identity === null && guestDraft && (
        <IdentityGate open={true} guest={guestDraft} onDone={setIdentity} />
      )}

      {/* ---------- notes board (remounts fresh each time it opens) ---------- */}
      <BoardView
        key={`board-${boardOpen}`}
        open={boardOpen}
        onClose={() => setBoardOpen(false)}
        onPagesChanged={refreshPages}
      />
    </div>
  )
}
