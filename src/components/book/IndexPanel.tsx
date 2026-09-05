'use client'

import { useEffect, useMemo, useRef } from 'react'
import { BookMarked, Pin, FilePlus2, NotebookPen, X, Loader2 } from 'lucide-react'
import type { PageData } from '@/lib/types'

interface IndexPanelProps {
  open: boolean
  pages: PageData[]
  noteCounts: Record<number, number>
  /** page number currently open on the right face */
  currentPage: number
  /** the flyleaf row only works in spread mode — hide it on narrow screens */
  showFlyleaf?: boolean
  onClose(): void
  onGoToPage(pageNumber: number): void
  onNewPage(): void
}

function pageLabel(p: PageData): string {
  const title = (p.title ?? '').trim()
  if (title) return title.replace(/<[^>]*>/g, '')
  const first =
    (p.content ?? '')
      .replace(/<[^>]*>/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  if (first) return first.length > 46 ? `${first.slice(0, 46)}…` : first
  return 'Blank page'
}

/**
 * The book's index — a live table of contents built from the pages as they
 * exist right now (created, written, renumbered). Clicking a row riffles the
 * book straight to that page. Pin markers show which pages are kept even
 * when empty; the note badges count margin notes per page.
 */
export default function IndexPanel({ open, pages, noteCounts, currentPage, showFlyleaf = true, onClose, onGoToPage, onNewPage }: IndexPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // keep the current page in view while the index is open
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('.index-row--current')
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, currentPage])

  const numbered = useMemo(() => pages.filter((p) => p.pageNumber > 0), [pages])
  const flyleaf = useMemo(() => pages.find((p) => p.pageNumber === 0) ?? null, [pages])

  if (!open) return null

  return (
    <nav className={`index-panel ${open ? 'index-panel--open' : ''}`} aria-label="Book index">
      <header className="index-head">
        <div className="index-title">
          <BookMarked size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>Index</span>
          <span className="index-count">{numbered.length} {numbered.length === 1 ? 'page' : 'pages'}</span>
        </div>
        <button type="button" className="index-close" onClick={onClose} aria-label="Close the index">
          <X size={16} strokeWidth={2} />
        </button>
      </header>

      <div className="index-list" ref={listRef}>
        {flyleaf && showFlyleaf && (
          <button
            type="button"
            className={`index-row ${currentPage === 0 ? 'index-row--current' : ''}`}
            onClick={() => onGoToPage(0)}
          >
            <span className="index-folio index-folio--fly">❦</span>
            <span className="index-label">
              <span className="index-label-main">Ex Libris — flyleaf</span>
              <span className="index-label-sub">inside the front cover</span>
            </span>
          </button>
        )}

        {numbered.map((p) => {
          const notes = noteCounts[p.pageNumber] ?? 0
          const current = p.pageNumber === currentPage
          return (
            <button
              key={p.id}
              type="button"
              className={`index-row ${current ? 'index-row--current' : ''}`}
              onClick={() => onGoToPage(p.pageNumber)}
              aria-current={current ? 'page' : undefined}
            >
              <span className="index-folio">{p.pageNumber}</span>
              <span className="index-label">
                <span className="index-label-main">{pageLabel(p)}</span>
                <span className="index-label-sub">
                  {(p.content ?? '').replace(/<[^>]*>/g, ' ').trim()
                    ? `${(p.content ?? '').replace(/<[^>]*>/g, ' ').trim().split(/\s+/).length} words`
                    : 'kept blank'}
                </span>
              </span>
              <span className="index-marks">
                {notes > 0 && (
                  <span className="index-note-badge" title={`${notes} margin note${notes > 1 ? 's' : ''}`}>
                    <NotebookPen size={11} strokeWidth={2} aria-hidden="true" />
                    {notes}
                  </span>
                )}
                {p.pinned && (
                  <span className="index-pin" title="Pinned — kept even when empty">
                    <Pin size={12} strokeWidth={2.2} aria-hidden="true" />
                  </span>
                )}
              </span>
            </button>
          )
        })}

        {numbered.length === 0 && !flyleaf && (
          <div className="index-empty">
            <Loader2 className="spin" size={16} strokeWidth={2} aria-hidden="true" />
            <span>No pages yet — write the first one.</span>
          </div>
        )}
      </div>

      <footer className="index-foot">
        <button type="button" className="index-new" onClick={onNewPage}>
          <FilePlus2 size={14} strokeWidth={2} aria-hidden="true" />
          New page after the one you are reading
        </button>
        <p className="index-note">
          Numbering heals itself: remove a page and the next one takes its number.
        </p>
      </footer>
    </nav>
  )
}
