'use client'

import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { NotebookPen, Pin, Trash2, FilePlus2, Plus } from 'lucide-react'
import type { PageData } from '@/lib/types'
import FloatingEditorToolbar, { HIGHLIGHT_COLORS, LEGACY_HIGHLIGHT_COLORS } from './FloatingEditorToolbar'

/** hex swatch → persistent CSS class (colors survive sanitize + reload). */
function highlightClassForHex(hex: string): string {
  return HIGHLIGHT_COLORS.find((c) => c.hex.toLowerCase() === String(hex).toLowerCase())?.class ?? 'ink-hl-yellow'
}

/** CSS class → hex swatch for the toolbar indicator (incl. retired classes). */
function highlightHexForMark(mark: Element): string | null {
  const found =
    HIGHLIGHT_COLORS.find((c) => mark.classList.contains(c.class)) ??
    LEGACY_HIGHLIGHT_COLORS.find((c) => mark.classList.contains(c.class))
  if (found) return found.hex
  const inline = (mark as HTMLElement).style?.backgroundColor
  return inline || null
}

interface PageFaceProps {
  page: PageData | null
  /** pageNumber when the page doesn't exist (the trailing blank page) */
  pageNumber: number
  noteCount?: number
  onOpenNotes?: (pageNumber: number) => void
  /** While the reading zoom is on the book is read-only. */
  readOnly?: boolean
  /** Leaf faces during a flip render as pure display (no editing chrome). */
  frozen?: boolean
  /** ----- page management (only on resting pages) ----- */
  /** Trailing blank: begin a new page here. */
  onCreatePage?: (pageNumber: number) => void
  onSavePage?: (pageId: string, patch: { content?: string; title?: string }) => void
  onTogglePagePin?: (page: PageData) => void
  onDeletePage?: (page: PageData) => void
  /** id of a page that was just created — its body takes focus. */
  focusId?: string | null
  /** ----- presence (Wave 1, all optional) ----- */
  identity?: { clientId: string; name: string; color: string } | null
  /** foreign edit lease on this page number (null when free or mine) */
  lockedBy?: { clientId: string; name: string; color: string } | null
  onLockAcquire?: (page: PageData) => void
  onLockRelease?: (pageId: string) => void
}

/** Converts stored content to safe HTML for contentEditable (H-1: XSS fix). */
function formatInitialContent(content: string): string {
  if (!content) return ''
  // Heal first: old saves with literal `&lt;span&gt;` text must render as
  // text again immediately (the next save then persists the clean version).
  const healed = healEscapedInlineTagsClient(content)
  // Stored content may be legacy plain text or sanitized HTML. Never pass
  // raw HTML through: escape plain-text lines, sanitize anything tag-like.
  if (/<(p|div|h[1-6]|ul|ol|li|mark|b|i|u|strong|em|br)\b[^>]*>/i.test(healed)) {
    return sanitizePageHtmlClient(healed)
  }
  const lines = healed.split('\n')
  return lines
    .map((line) => (line.trim() === '' ? '<p><br></p>' : `<p>${escapeHtmlClient(line)}</p>`))
    .join('')
}

function escapeHtmlClient(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Heal old escaped inline tags so saved `&lt;span&gt;` text stops showing as code. */
function healEscapedInlineTagsClient(html: string): string {
  return String(html ?? '').replace(/&lt;(\/?)(span|font)\b([^&]*?)&gt;/gi, '<$1$2$3>')
}

/** Client-side mirror of sanitizePageHtml (kept dependency-free). */
function sanitizePageHtmlClient(html: string, maxLen = 20000): string {
  if (!html) return ''
  let out = String(html).slice(0, maxLen + 4096)
  out = healEscapedInlineTagsClient(out)
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  out = out.replace(
    /<\/?\s*(script|style|iframe|object|embed|link|meta|svg|math|form|input|textarea|button|select|option|frame|frameset|base|applet|audio|video|source|track|canvas|noscript|template)\b[^>]*>?/gi,
    ''
  )
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  out = out.replace(/\s+(href|src|xlink:href|action)\s*=\s*("|')?\s*(javascript|data\s*:\s*text\/html|vbscript)\s*:[^>"'\s]*/gi, '')
  out = out.replace(/\s+style\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // Unwrap spans/fonts (paste/execCommand residue + healed entities above).
  out = out.replace(/<\/?\s*(span|font)\b[^>]*>/gi, '')
  // Mirror of the server rule: only h3 survives, so downgrade the rest.
  out = out.replace(/<\s*(\/?)\s*h[12456]\b[^>]*>/gi, (_m, close: string) =>
    close ? '</h3>' : '<h3>'
  )
  const allowed = new Set([
    'p', 'br', 'b', 'i', 'u', 's', 'strong', 'em', 'mark', 'h3',
    'ul', 'ol', 'li', 'blockquote', 'div',
  ])
  // Keep only the editor's own highlighter classes on <mark>.
  const markClassOk = (c: string) =>
    /^ink-hl(-(yellow|green|pink|blue|purple|orange|red|teal|slate|stone|charcoal))?$/.test(c)
  out = out.replace(/<\/?\s*([a-zA-Z0-9]+)\b[^>]*>/g, (m, tag: string) => {
    const t = String(tag).toLowerCase()
    if (allowed.has(t)) {
      if (t === 'br') return '<br>'
      const isClose = /^<\s*\//.test(m)
      if (!isClose && t === 'mark') {
        const raw = m.match(/\bclass\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i)?.[1] ?? ''
        const kept = raw
          .replace(/^['"]|['"]$/g, '')
          .split(/\s+/)
          .filter(markClassOk)
          .join(' ')
        return kept ? `<mark class="${kept}">` : '<mark>'
      }
      return isClose ? `</${t}>` : `<${t}>`
    }
    return escapeHtmlClient(m)
  })
  return out.slice(0, maxLen)
}

/**
 * One face of the book: a writable ruled page.
 *
 * The paper has printed rules like a real notebook and the type sits ON the
 * line (the rule runs just under the text baseline — see .page-ruled-input).
 * Titles are set in the bold serif header; the body supports ink formatting
 * (bold, italic, underline, heading, lists, highlighters) via Ctrl+E or selection.
 */
export default function PageFace(props: PageFaceProps) {
  const {
    page,
    pageNumber,
    noteCount = 0,
    onOpenNotes,
    readOnly,
    frozen,
    onCreatePage,
    onSavePage,
    onTogglePagePin,
    onDeletePage,
    focusId,
    identity,
    lockedBy,
    onLockAcquire,
    onLockRelease,
  } = props

  const manage = !frozen && !!page
  // A foreign-held lease makes the face read-only (own lease or free = writable).
  const foreignLocked = !!lockedBy && (!identity || lockedBy.clientId !== identity.clientId)
  const ro = readOnly || foreignLocked

  const [draft, setDraft] = useState({ content: page?.content ?? '', title: page?.title ?? '' })
  const [sync, setSync] = useState({ id: page?.id ?? '', content: page?.content ?? '', title: page?.title ?? '' })
  const saved = useRef({ id: page?.id ?? '', content: page?.content ?? '', title: page?.title ?? '' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRef = useRef<((override?: { content?: string; title?: string }) => void) | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const isComposing = useRef(false)

  // Floating toolbar state
  const [toolbar, setToolbar] = useState<{ visible: boolean; x: number; y: number }>({
    visible: false,
    x: 0,
    y: 0,
  })
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    heading: false,
    bullet: false,
    numbered: false,
    highlight: null as string | null,
  })
  const toggledByHotkey = useRef(false)

  // Adopt page changes during render
  const pageId = page?.id ?? ''
  const pageContent = page?.content ?? ''
  const pageTitle = page?.title ?? ''
  const dirty = draft.content !== sync.content || draft.title !== sync.title
  const idChanged = pageId !== sync.id
  const externalEdit = !idChanged && !dirty && (pageContent !== sync.content || pageTitle !== sync.title)
  if (idChanged || externalEdit) {
    setSync({ id: pageId, content: pageContent, title: pageTitle })
    setDraft({ content: pageContent, title: pageTitle })
  }

  // Live page id for timers: a flush armed on page A must never fire after
  // the face has moved on to page B (same instance, new props).
  const pageIdRef = useRef(pageId)
  // Populate contentEditable on page change or mount
  useEffect(() => {
    // Flush the previous owner's pending words BEFORE adopting the new page:
    // this effect is declared before the draft mirror below, so draftRef
    // still holds the old page's words and the owner guard lets it through.
    // Without this, a turn inside the 700ms window silently drops keystrokes.
    try {
      flushRef.current?.()
    } catch {}
    // Live page id for timers: a flush armed on page A must never fire after
    // the face has moved on to page B (same instance, new props).
    pageIdRef.current = pageId
    if (bodyRef.current && page) {
      const activeEl = document.activeElement
      const isFocused = activeEl === bodyRef.current || bodyRef.current.contains(activeEl)
      if (!isFocused || idChanged) {
        bodyRef.current.innerHTML = formatInitialContent(draft.content)
      }
    }
  }, [pageId, idChanged])

  // flush pending words when face unmounts
  useEffect(() => () => { flushRef.current?.() }, [])

  // Freshly created page: drop caret straight onto paper once
  const focusConsumed = useRef<string | null>(null)
  useEffect(() => {
    if (page && focusId && page.id === focusId && focusConsumed.current !== page.id) {
      focusConsumed.current = page.id
      const t = setTimeout(() => {
        if (bodyRef.current) {
          bodyRef.current.focus()
          // place caret at end
          const range = document.createRange()
          const sel = window.getSelection()
          range.selectNodeContents(bodyRef.current)
          range.collapse(false)
          sel?.removeAllRanges()
          sel?.addRange(range)
        }
      }, 140)
      return () => clearTimeout(t)
    }
  }, [page?.id, focusId])

  // Freshest draft for timers: render-scope `draft` goes stale when a title
  // keystroke and a body keystroke land inside one 700ms debounce window —
  // reading the mirror at fire time (not schedule time) stops one field
  // eating the other. Immediate flushes pass explicit values for the same
  // reason (the mirror effect hasn't committed yet when they run).
  const draftRef = useRef(draft)
  useEffect(() => {
    draftRef.current = draft
  }, [draft])

  const scheduleSave = () => {
    if (!page || !onSavePage || ro) return
    const ownerId = page.id
    if (timer.current) clearTimeout(timer.current)
    flushRef.current = (override?: { content?: string; title?: string }) => {
      timer.current = null
      // Never write another page's words: if the face moved on while this
      // timer was armed, drop the flush (the new page arms its own).
      if (ownerId !== pageIdRef.current) return
      const d = draftRef.current
      const content = override?.content ?? d.content
      const title = override?.title ?? d.title
      if (content === saved.current.content && title === saved.current.title) return
      saved.current = { id: page.id, content, title }
      setSync({ id: page.id, content, title })
      onSavePage(page.id, { content, title })
    }
    timer.current = setTimeout(() => { flushRef.current?.() }, 700)
  }

  const flushNow = () => {
    if (bodyRef.current) {
      const currentHtml = sanitizePageHtmlClient(bodyRef.current.innerHTML)
      if (currentHtml !== draft.content) {
        setDraft((d) => ({ ...d, content: currentHtml }))
        scheduleSave()
        flushRef.current?.({ content: currentHtml })
        return
      }
    }
    flushRef.current?.()
  }

  const onBodyInput = () => {
    if (!bodyRef.current) return
    const v = sanitizePageHtmlClient(bodyRef.current.innerHTML)
    setDraft((d) => ({ ...d, content: v }))
    scheduleSave()
  }

  const onTitleChange = (v: string) => {
    setDraft((d) => ({ ...d, title: v }))
    scheduleSave()
  }

  // Last known-good in-body selection. Mobile taps on the floating toolbar
  // can collapse the DOM selection before onClick fires; formatting then
  // restores this range instead of silently no-op-ing (or worse, formatting
  // the wrong spot). Updated on every valid selection, summon, and input.
  const lastGoodRange = useRef<{ range: Range; at: number } | null>(null)
  const rememberRange = useCallback(() => {
    try {
      const sel = window.getSelection()
      if (
        sel &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        bodyRef.current?.contains(sel.anchorNode)
      ) {
        lastGoodRange.current = { range: sel.getRangeAt(0).cloneRange(), at: Date.now() }
      }
    } catch {}
  }, [])

  /**
   * Restore the remembered range when the live selection is unusable.
   * Freshness-gated (1.5s): a tap must only ever resurrect the selection you
   * just made — never reformat text you selected a while ago. (Deliberately
   * not cleared on collapse/blur: the tap that needs the restore collapses
   * first, so clearing there would defeat the mechanism.)
   */
  const ensureSelection = useCallback((): boolean => {
    try {
      const sel = window.getSelection()
      if (
        sel &&
        sel.rangeCount > 0 &&
        !sel.isCollapsed &&
        bodyRef.current?.contains(sel.anchorNode)
      ) {
        rememberRange()
        return true
      }
      const saved = lastGoodRange.current
      if (saved && Date.now() - saved.at < 1500 && bodyRef.current) {
        bodyRef.current.focus({ preventScroll: true })
        sel?.removeAllRanges()
        sel?.addRange(saved.range.cloneRange())
        return true
      }
    } catch {}
    return false
  }, [rememberRange])

  // Inspect current text format under caret / selection
  const checkFormats = useCallback(() => {
    if (typeof document === 'undefined') return
    try {
      const isBold = document.queryCommandState('bold')
      const isItalic = document.queryCommandState('italic')
      const isUnderline = document.queryCommandState('underline')
      const isBullet = document.queryCommandState('insertUnorderedList')
      const isNumbered = document.queryCommandState('insertOrderedList')
      const formatBlock = document.queryCommandValue('formatBlock')
      const isHeading = formatBlock === 'h1' || formatBlock === 'h2' || formatBlock === 'h3'

      let highlight: string | null = null
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const parent = sel.anchorNode?.parentElement
        const mark = parent?.closest('mark')
        if (mark) {
          highlight = highlightHexForMark(mark) || '#fef08a'
        }
      }

      setActiveFormats({
        bold: isBold,
        italic: isItalic,
        underline: isUnderline,
        heading: isHeading,
        bullet: isBullet,
        numbered: isNumbered,
        highlight,
      })
    } catch {}
  }, [])

  /** Clamp a viewport point so the floating toolbar never renders off-screen. */
  const clampToolbarPos = (x: number, y: number) => {
    if (typeof window === 'undefined') return { x: Math.round(x), y: Math.round(y) }
    const vw = window.innerWidth
    const vh = window.innerHeight
    return {
      x: Math.round(Math.min(Math.max(x, 110), Math.max(110, vw - 110))),
      y: Math.round(Math.min(Math.max(y, 64), Math.max(64, vh - 24))),
    }
  }

  /** Show the ink toolbar at a viewport point (shared by selection + hotkey). */
  const summonToolbar = useCallback((x: number, y: number, viaHotkey: boolean) => {
    toggledByHotkey.current = viaHotkey
    const p = clampToolbarPos(x, y)
    setToolbar({ visible: true, x: p.x, y: p.y })
    checkFormats()
  }, [checkFormats])

  // Selection change handler: show toolbar when text is selected inside this page
  const updateSelectionToolbar = useCallback(() => {
    if (ro || frozen) {
      setToolbar((prev) => (prev.visible ? { ...prev, visible: false } : prev))
      return
    }

    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      if (!toggledByHotkey.current) {
        setToolbar((prev) => (prev.visible ? { ...prev, visible: false } : prev))
      }
      return
    }

    // Must be inside this bodyRef
    if (bodyRef.current && bodyRef.current.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0) {
        rememberRange()
        summonToolbar(rect.left + rect.width / 2, rect.top - 6, false)
      }
    }
  }, [ro, frozen, checkFormats, summonToolbar, rememberRange])

  /** Compute a summon point: caret/selection rect, else body center. */
  const summonPoint = () => {
    const sel = window.getSelection()
    let x = 0
    let y = 0

    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (rect.width > 0 || rect.top > 0) {
        x = rect.left + rect.width / 2
        y = rect.top - 8
      }
    }

    if ((x === 0 || y === 0) && bodyRef.current) {
      const bodyRect = bodyRef.current.getBoundingClientRect()
      x = bodyRect.left + bodyRect.width / 2
      y = bodyRect.top + 36
    }
    return { x, y }
  }

  // Keydown handler: Ctrl/Cmd+E summons or dismisses the ink editor.
  // (Shift+T intentionally types a capital T — it used to summon and made
  // the letter untypeable.)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault()
      e.stopPropagation()
      if (ro || frozen) return

      if (toolbar.visible) {
        setToolbar((prev) => ({ ...prev, visible: false }))
        toggledByHotkey.current = false
        return
      }

      const { x, y } = summonPoint()
      summonToolbar(x, y, true)
    }
  }

  // Same hotkey from the title input.
  const handleTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      flushNow()
      bodyRef.current?.focus()
      return
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
      e.preventDefault()
      e.stopPropagation()
      if (ro || frozen) return
      bodyRef.current?.focus()
      const { x, y } = summonPoint()
      summonToolbar(x, y, true)
    }
  }

  // Handle format action from the floating toolbar
  const handleFormat = (command: string, value?: string) => {
    if (ro || frozen) return
    bodyRef.current?.focus()
    // Touch taps can collapse the selection before onClick fires. Only
    // range-needing commands restore the remembered range — caret-state
    // commands (bold at caret, bullet toggle) must act where the caret is.
    const needsRange = command === 'highlight' || command === 'removeFormat'
    if (needsRange && !ensureSelection()) return

    if (command === 'bold') {
      document.execCommand('bold', false)
    } else if (command === 'italic') {
      document.execCommand('italic', false)
    } else if (command === 'underline') {
      document.execCommand('underline', false)
    } else if (command === 'heading') {
      const isH = document.queryCommandValue('formatBlock') === 'h3'
      document.execCommand('formatBlock', false, isH ? '<p>' : '<h3>')
    } else if (command === 'bulletList') {
      document.execCommand('insertUnorderedList', false)
    } else if (command === 'orderedList') {
      document.execCommand('insertOrderedList', false)
    } else if (command === 'removeFormat') {
      document.execCommand('removeFormat', false)
      // Remove highlight marks: intersecting ones for a real selection, plus —
      // for a bare caret (or an empty line, where no text selection exists) —
      // the mark under the caret and any empty highlight shells in the block
      // (leftover <mark><br></mark> stubs like the one that stranded page 4).
      const unwrapMark = (m: Element) => {
        const parent = m.parentNode
        while (m.firstChild) parent?.insertBefore(m.firstChild, m)
        parent?.removeChild(m)
      }
      const isEmptyShell = (m: Element) =>
        ((m.textContent ?? '').replace(/[\s\u00a0]/g, '') === '')
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const range = sel.getRangeAt(0)
        const marks = bodyRef.current?.querySelectorAll('mark')
        marks?.forEach((m) => {
          try {
            if (range.intersectsNode(m)) unwrapMark(m)
          } catch {}
        })
      } else {
        const anchorEl =
          sel?.anchorNode instanceof Element
            ? sel.anchorNode
            : sel?.anchorNode?.parentElement ?? null
        const caretMark = anchorEl?.closest?.('mark') ?? null
        if (caretMark && bodyRef.current?.contains(caretMark)) unwrapMark(caretMark)
        const block = anchorEl?.closest?.('p, li, h3, div, blockquote') ?? null
        const scope = block && bodyRef.current?.contains(block) ? block : bodyRef.current
        scope?.querySelectorAll('mark')?.forEach((m) => {
          if (isEmptyShell(m)) unwrapMark(m)
        })
      }
    } else if (command === 'highlight' && value) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0)
        const cls = highlightClassForHex(value)
        // Replace, don't nest: strip every highlight intersecting the range
        // first, so a new color swaps the old one instead of layering above it.
        const marks = bodyRef.current?.querySelectorAll('mark')
        const intersecting: Element[] = []
        marks?.forEach((m) => {
          try {
            if (range.intersectsNode(m)) intersecting.push(m)
          } catch {}
        })
        // Toggle off only when the whole selection is exactly one same-colored mark.
        const singleSame =
          intersecting.length === 1 &&
          intersecting[0].classList.contains(cls) &&
          range.toString() === intersecting[0].textContent
        intersecting.forEach((m) => {
          const parent = m.parentNode
          while (m.firstChild) parent?.insertBefore(m.firstChild, m)
          parent?.removeChild(m)
        })
        if (!singleSame) {
          // Class-based (never inline style): survives sanitize + reload.
          // No execCommand fallback: hiliteColor fabricates <span>s, which is
          // exactly the visible-code artifact this sanitizer unwraps.
          const mark = document.createElement('mark')
          mark.className = `ink-hl ${cls}`
          try {
            const contents = range.extractContents()
            mark.appendChild(contents)
            range.insertNode(mark)
            sel.removeAllRanges()
            const newRange = document.createRange()
            newRange.selectNode(mark)
            sel.addRange(newRange)
          } catch {
            // Selection too complex to wrap cleanly: leave it unwrapped rather
            // than nesting or inline-styling (both lose on save).
          }
        }
      }
    }

    if (bodyRef.current) {
      onBodyInput()
    }
    checkFormats()
  }

  // ---------- flyleaf (inside of the cover — static Ex Libris bookplate) ----------
  if (page && pageNumber === 0) {
    return (
      <div className="page-paper page-paper--flyleaf">
        <div className="flyleaf-frame">
          <div className="flyleaf-ornament" aria-hidden="true">❦</div>
          <div className="flyleaf-title">Ex Libris</div>
          <div className="flyleaf-rule" />
          <div className="flyleaf-text">{page.content}</div>
          <div className="flyleaf-rule" />
          <div className="flyleaf-ornament" aria-hidden="true">❦</div>
        </div>
      </div>
    )
  }

  // ---------- trailing blank: the next page waits to be begun ----------
  // (Locks never gate creation: a blank has no holder by definition.)
  if (!page) {
    const canBegin = !frozen && !readOnly && !!onCreatePage && pageNumber > 0
    return (
      <div className="page-paper page-paper--ruled" data-blank="true">
        <div className="page-write-head" aria-hidden="true">
          <span className="page-kicker page-kicker--blank">Next page</span>
        </div>
        <div className="page-write-body page-write-body--blank">
          {canBegin ? (
            <>
              <button
                type="button"
                className="page-begin"
                onClick={(e) => {
                  e.stopPropagation()
                  onCreatePage(pageNumber > 1 ? pageNumber - 1 : 0)
                }}
                onPointerDown={(e) => e.stopPropagation()}
                aria-label={`Begin page ${pageNumber} — start writing on a fresh page`}
              >
                <FilePlus2 size={17} strokeWidth={1.8} aria-hidden="true" />
                Begin page {pageNumber}
              </button>
              <p className="page-begin-hint">Write here and the page is kept.<br />Leave it empty and it stays blank.</p>
            </>
          ) : (
            frozen ? <span className="page-ghost-number">{pageNumber > 0 ? pageNumber : ''}</span> : null
          )}
        </div>
        <footer className="page-foot">
          <span className="page-number page-number-blank">{pageNumber > 0 ? `· ${pageNumber} ·` : ''}</span>
        </footer>
      </div>
    )
  }

  // ---------- writable ruled page ----------
  const showTools = manage && !ro && (!!onTogglePagePin || !!onDeletePage)

  return (
    <div className={`page-paper page-paper--ruled ${page.pinned ? 'page-paper--pinned' : ''}`}>
      <header
        className="page-write-head"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => { if (!frozen) e.stopPropagation() }}
      >
        <input
          ref={titleRef}
          className="page-title-input"
          type="text"
          value={draft.title}
          placeholder="Untitled page"
          readOnly={ro || frozen}
          maxLength={200}
          aria-label={`Title of page ${pageNumber}`}
          onChange={(e) => onTitleChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={handleTitleKeyDown}
          onBlur={flushNow}
          onPointerDown={(e) => { if (!frozen) e.stopPropagation() }}
          onMouseDown={(e) => { if (!frozen) e.stopPropagation() }}
        />
        <div className="page-title-rule" aria-hidden="true" />
        <span className="page-kicker page-kicker--write">{page.section || 'Writing'}</span>
      </header>

      <div
        className="page-write-body"
        onClick={(e) => {
          if (e.target === e.currentTarget && !frozen && !ro) {
            bodyRef.current?.focus()
          }
        }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget && !frozen && !ro) {
            bodyRef.current?.focus()
          }
        }}
      >
        <div
          ref={bodyRef}
          className="page-ruled-input"
          contentEditable={!ro && !frozen}
          suppressContentEditableWarning
          data-placeholder={ro ? '' : 'Write on this page…'}
          aria-label={`Body of page ${pageNumber}`}
          onInput={onBodyInput}
          onKeyDown={handleKeyDown}
          onMouseUp={updateSelectionToolbar}
          onKeyUp={updateSelectionToolbar}
          onFocus={() => {
            // First touchpoint ≈ intent to write: take the lease (idempotent;
            // server toasts when someone else holds it).
            if (page && !frozen && !readOnly && onLockAcquire) onLockAcquire(page)
          }}
          onBlur={() => {
            flushNow()
            if (page && onLockRelease) onLockRelease(page.id)
          }}
          onClick={(e) => {
            e.stopPropagation()
            updateSelectionToolbar()
          }}
          onPointerDown={(e) => {
            if (!frozen) e.stopPropagation()
          }}
          onMouseDown={(e) => {
            if (!frozen) e.stopPropagation()
          }}
          spellCheck={false}
        />
      </div>

      <footer className="page-foot">
        <span className="page-number">· {pageNumber} ·</span>
      </footer>

      {/* Floating Ink Editor Toolbar on Selection or Ctrl+E.
          Portaled to document.body: inside the book's 3D-transformed rig,
          position:fixed would resolve against the transformed ancestor and
          land the toolbar far off-screen. Viewport coords need a viewport root. */}
      {!ro && !frozen && typeof document !== 'undefined' &&
        createPortal(
          <FloatingEditorToolbar
            visible={toolbar.visible}
            x={toolbar.x}
            y={toolbar.y}
            onClose={() => {
              setToolbar((prev) => ({ ...prev, visible: false }))
              toggledByHotkey.current = false
            }}
            onFormat={handleFormat}
            activeFormats={activeFormats}
          />,
          document.body
        )}

      {/* per-page tools: pin (keep even when empty) + remove (asks first) */}
      {showTools && (
        <div
          className="page-tools"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {onTogglePagePin && (
            <button
              type="button"
              className={`page-tool ${page.pinned ? 'page-tool--pinned' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                flushNow()
                onTogglePagePin({ ...page, content: draft.content, title: draft.title })
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-pressed={page.pinned}
              aria-label={page.pinned ? 'Unpin page — it can be removed when empty' : 'Pin page — keep it even when empty'}
              title={page.pinned ? 'Pinned — this page is kept even when empty' : 'Pin this page — keep it even when empty'}
            >
              <Pin size={13} strokeWidth={2.1} aria-hidden="true" />
            </button>
          )}
          {onDeletePage && (
            <button
              type="button"
              className="page-tool page-tool--remove"
              onClick={(e) => {
                e.stopPropagation()
                flushNow()
                onDeletePage({ ...page, content: draft.content, title: draft.title })
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label={`Remove page ${pageNumber}`}
              title="Remove this page"
            >
              <Trash2 size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      )}

      {page.pinned && !frozen && <span className="page-pin-flag" aria-hidden="true"><Pin size={10} strokeWidth={2.4} /></span>}

      {/* foreign edit lease: read-only for me, with the holder named */}
      {foreignLocked && lockedBy && !frozen && (
        <div
          className="page-lock-banner"
          role="status"
          style={{ ['--lock-color' as string]: lockedBy.color }}
        >
          <span className="page-lock-dot" aria-hidden="true" />
          {lockedBy.name} is writing — read-only for you
        </div>
      )}

      {/* per-page add: a + in the free footer corner makes the next page
          right where you are (mirrored opposite the notes marker by CSS) */}
      {/* + stays live under a foreign lock: blocked writers can always branch */}
      {manage && !readOnly && onCreatePage && pageNumber > 0 && (
        <button
          type="button"
          className="page-add"
          onClick={(e) => {
            e.stopPropagation()
            flushNow()
            onCreatePage(pageNumber)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          aria-label={`Add a page after page ${pageNumber}`}
          title="New page after this one (N)"
        >
          <Plus size={17} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}

      {onOpenNotes && (
        <button
          type="button"
          className={`page-note-marker ${ro ? 'page-note-marker--off' : ''}`}
          disabled={ro}
          onClick={(e) => {
            if (ro) return
            e.stopPropagation()
            onOpenNotes(pageNumber)
          }}
          aria-label={ro ? 'Notes are read-only while zoom is on' : `Margin notes for page ${pageNumber}`}
        >
          <NotebookPen strokeWidth={1.8} size="1em" />
          {noteCount > 0 && <span className="page-note-count">{noteCount}</span>}
        </button>
      )}
    </div>
  )
}
