'use client'

import React, { useEffect, useRef, useState } from 'react'
import {
  List,
  ListOrdered,
  Eraser,
  Highlighter,
} from 'lucide-react'

export interface FloatingToolbarProps {
  visible: boolean
  x: number
  y: number
  onClose(): void
  onFormat(command: string, value?: string): void
  activeFormats?: {
    bold?: boolean
    italic?: boolean
    underline?: boolean
    heading?: boolean
    bullet?: boolean
    numbered?: boolean
    highlight?: string | null
  }
}

export const HIGHLIGHT_COLORS = [
  { name: 'Canary Yellow', hex: '#fef08a', border: '#eab308', class: 'ink-hl-yellow' },
  { name: 'Mint Green', hex: '#bbf7d0', border: '#22c55e', class: 'ink-hl-green' },
  { name: 'Blossom Pink', hex: '#fbcfe8', border: '#ec4899', class: 'ink-hl-pink' },
  { name: 'Powder Blue', hex: '#bae6fd', border: '#0ea5e9', class: 'ink-hl-blue' },
  { name: 'Lilac', hex: '#e9d5ff', border: '#a855f7', class: 'ink-hl-purple' },
  { name: 'Lagoon Teal', hex: '#99f6e4', border: '#14b8a6', class: 'ink-hl-teal' },
  { name: 'Slate Grey', hex: '#e2e8f0', border: '#64748b', class: 'ink-hl-slate' },
  { name: 'Stone Grey', hex: '#d6d3d1', border: '#78716c', class: 'ink-hl-stone' },
  { name: 'Charcoal Black', hex: '#44403c', border: '#1c1917', class: 'ink-hl-charcoal' },
]

// Retired palette classes: still render + survive sanitize so older
// highlights never break, and the toolbar can still name their color.
export const LEGACY_HIGHLIGHT_COLORS = [
  { name: 'Tangerine', hex: '#fed7aa', class: 'ink-hl-orange' },
  { name: 'Cherry Red', hex: '#fecdd3', class: 'ink-hl-red' },
]

export default function FloatingEditorToolbar({
  visible,
  x,
  y,
  onClose,
  onFormat,
  activeFormats = {},
}: FloatingToolbarProps) {
  const [showColorPicker, setShowColorPicker] = useState(false)
  const toolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!visible) {
      // Deferred a tick: resetting a hidden picker's state is invisible, and
      // the effect body stays free of synchronous setState.
      const t = setTimeout(() => setShowColorPicker(false), 0)
      return () => clearTimeout(t)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      // Toggle-off when focus sits on a toolbar button (the page hotkey
      // can't see those keystrokes — the toolbar lives in a portal).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        onClose()
      }
    }

    const onMouseDown = (e: MouseEvent) => {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('mousedown', onMouseDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('mousedown', onMouseDown)
    }
  }, [visible, onClose])

  if (!visible) return null

  return (
    <div
      ref={toolbarRef}
      className="floating-ink-toolbar"
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
      onPointerDown={(e) => {
        // Stop bubbling so selection inside page is not cancelled
        e.stopPropagation()
      }}
      onMouseDown={(e) => {
        e.preventDefault() // prevent losing focus/selection
        e.stopPropagation()
      }}
      role="toolbar"
      aria-label="Ink Text Formatting"
    >
      {/* Bold */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.bold ? 'ink-btn--active' : ''}`}
        title="Bold (Ctrl+B)"
        aria-label="Bold"
        onClick={() => onFormat('bold')}
      >
        <span className="ink-btn-text font-bold">B</span>
      </button>

      {/* Italic */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.italic ? 'ink-btn--active' : ''}`}
        title="Italic (Ctrl+I)"
        aria-label="Italic"
        onClick={() => onFormat('italic')}
      >
        <span className="ink-btn-text italic font-serif">I</span>
      </button>

      {/* Underline */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.underline ? 'ink-btn--active' : ''}`}
        title="Underline (Ctrl+U)"
        aria-label="Underline"
        onClick={() => onFormat('underline')}
      >
        <span className="ink-btn-text underline decoration-1 underline-offset-2">U</span>
      </button>

      <div className="ink-divider" aria-hidden="true" />

      {/* Heading */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.heading ? 'ink-btn--active' : ''}`}
        title="Section Heading (H)"
        aria-label="Section Heading"
        onClick={() => onFormat('heading')}
      >
        <span className="ink-btn-text font-serif font-bold">H</span>
      </button>

      {/* Bullet List */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.bullet ? 'ink-btn--active' : ''}`}
        title="Bulleted List"
        aria-label="Bulleted List"
        onClick={() => onFormat('bulletList')}
      >
        <List size={16} strokeWidth={2.2} />
      </button>

      {/* Numbered List */}
      <button
        type="button"
        className={`ink-btn ${activeFormats.numbered ? 'ink-btn--active' : ''}`}
        title="Numbered List"
        aria-label="Numbered List"
        onClick={() => onFormat('orderedList')}
      >
        <ListOrdered size={16} strokeWidth={2.2} />
      </button>

      <div className="ink-divider" aria-hidden="true" />

      {/* Highlighter Button with Color Palette */}
      <div className="relative inline-flex items-center">
        <button
          type="button"
          className={`ink-btn ${activeFormats.highlight || showColorPicker ? 'ink-btn--active' : ''}`}
          title="Highlighter"
          aria-label="Highlighter"
          onClick={() => setShowColorPicker((prev) => !prev)}
        >
          <Highlighter size={15} strokeWidth={2} />
          <span
            className="ink-hl-indicator"
            style={{ backgroundColor: activeFormats.highlight || '#fef08a' }}
          />
        </button>

        {showColorPicker && (
          <div className="ink-color-palette" onMouseDown={(e) => e.preventDefault()}>
            {HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c.name}
                type="button"
                className="ink-color-dot"
                style={{ backgroundColor: c.hex, borderColor: c.border }}
                title={`Highlight with ${c.name}`}
                aria-label={`Highlight ${c.name}`}
                onClick={() => {
                  onFormat('highlight', c.hex)
                  setShowColorPicker(false)
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Eraser */}
      <button
        type="button"
        className="ink-btn ink-btn--eraser"
        title="Clear Formatting & Highlights"
        aria-label="Clear formatting"
        onClick={() => onFormat('removeFormat')}
      >
        <Eraser size={15} strokeWidth={2} />
      </button>
    </div>
  )
}
