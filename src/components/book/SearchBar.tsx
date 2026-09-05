'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, FileText, NotebookPen, CornerDownLeft, X } from 'lucide-react'
import type { PageData, PageNoteData } from '@/lib/types'

interface SearchBarProps {
  pages: PageData[]
  onGoToPage(pageNumber: number): void
  onOpenNote(note: PageNoteData): void
}

interface NoteHit extends PageNoteData {
  pageTitle: string
  section: string
}

interface PageHit {
  kind: 'page'
  pageNumber: number
  section: string
  title: string
  snippet: string
  matchStart: number
  matchEnd: number
}

interface NoteResult {
  kind: 'note'
  note: NoteHit
  matchStart: number
  matchEnd: number
}

type Hit = PageHit | NoteResult

function highlight(text: string, start: number, end: number) {
  return (
    <>
      {text.slice(Math.max(0, start - 46), start)}
      <mark className="search-mark">{text.slice(start, end)}</mark>
      {text.slice(end, end + 70)}
    </>
  )
}

function findMatch(haystack: string, q: string): { start: number; end: number } | null {
  const idx = haystack.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return null
  return { start: idx, end: idx + q.length }
}

export default function SearchBar({ pages, onGoToPage, onOpenNote }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [noteHits, setNoteHits] = useState<NoteHit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim()
    if (q.length < 2) return []
    const out: Hit[] = []

    // 1) local page search (books cluster data, already in memory)
    for (const p of pages) {
      if (p.pageNumber === 0) continue
      const cleanContent = p.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')
      const inTitle = findMatch(p.title, q)
      const inSection = findMatch(p.section, q)
      const inContent = findMatch(cleanContent, q)
      const m = inTitle ?? inSection ?? inContent
      if (m) {
        out.push({
          kind: 'page',
          pageNumber: p.pageNumber,
          section: p.section,
          title: p.title,
          snippet: inTitle ? p.title : inContent ? cleanContent : p.section,
          matchStart: inTitle ? inTitle.start : inContent ? inContent.start : inSection!.start,
          matchEnd: inTitle ? inTitle.end : inContent ? inContent.end : inSection!.end,
        })
      }
      if (out.length > 24) break
    }

    // 2) margin notes (notes cluster results)
    for (const n of noteHits) {
      const m = findMatch(n.content, q)
      if (m) {
        out.push({ kind: 'note', note: n, matchStart: m.start, matchEnd: m.end })
      }
    }
    return out
  }, [query, pages, noteHits])

  // debounce: fetch matching notes from the notes cluster
  useEffect(() => {
    const q = query.trim()
    let cancelled = false
    const t = setTimeout(async () => {
      if (q.length < 2) {
        if (!cancelled) setNoteHits([])
        return
      }
      try {
        const res = await fetch(`/api/notes/search?q=${encodeURIComponent(q)}`)
        if (!res.ok) return
        const data = await res.json()
        if (!cancelled) setNoteHits(data.notes ?? [])
      } catch {
        /* offline — page results still work */
      }
    }, 160)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  // keyboard shortcut: "/" focuses search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement
      const typing = el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // outside click closes
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [])

  // reset the highlighted result whenever the query changes (render-time reset)
  const [prevQuery, setPrevQuery] = useState(query)
  if (query !== prevQuery) {
    setPrevQuery(query)
    setActive(0)
  }

  const choose = (h: Hit) => {
    if (h.kind === 'page') onGoToPage(h.pageNumber)
    else onOpenNote(h.note)
    setOpen(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      inputRef.current?.blur()
      return
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setOpen(true)
      return
    }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(hits.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter' && hits[active]) {
      choose(hits[active])
    }
  }

  return (
    <div className="search-wrap" ref={wrapRef}>
      <div className="search-box">
        <Search className="search-icon" size={16} strokeWidth={2} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search pages, sections, text or notes…"
          aria-label="Search inside the book"
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus() }}>
            <X size={14} strokeWidth={2} />
          </button>
        ) : (
          <kbd className="search-kbd">/</kbd>
        )}
      </div>

      {open && query.trim().length >= 2 && (
        <div className="search-results" role="listbox">
          {hits.length === 0 ? (
            <div className="search-empty">No matches in pages or notes.</div>
          ) : (
            <>
              {hits.slice(0, 14).map((h, i) => (
                <button
                  key={h.kind === 'page' ? `p${h.pageNumber}` : `n${h.note.id}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  className={`search-result ${i === active ? 'search-result--active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(h)}
                >
                  <span className="search-result-icon">
                    {h.kind === 'page' ? <FileText size={15} strokeWidth={1.8} /> : <NotebookPen size={15} strokeWidth={1.8} />}
                  </span>
                  <span className="search-result-body">
                    <span className="search-result-title">
                      {h.kind === 'page' ? h.title : `Note · page ${h.note.pageNumber}`}
                      <em className="search-result-where">
                        {h.kind === 'page' ? `page ${h.pageNumber} · ${h.section}` : h.note.pageTitle}
                      </em>
                    </span>
                    <span className="search-result-snippet">
                      {h.kind === 'page'
                        ? highlight(h.snippet, h.matchStart, h.matchEnd)
                        : highlight(h.note.content, h.matchStart, h.matchEnd)}
                    </span>
                  </span>
                  {i === active && <CornerDownLeft className="search-result-go" size={14} strokeWidth={1.8} />}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
