export interface BookData {
  id: string
  title: string
  subtitle: string | null
  author: string
  description: string | null
  coverTheme: string
  /** Last page the reader had open (restored on reopen). */
  lastPage: number
  createdAt: string
  updatedAt: string
}

export interface PageData {
  id: string
  bookId: string
  pageNumber: number
  chapter: number
  section: string
  title: string
  content: string
  /** Pinned pages are kept even when empty (never auto-removed). */
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface PageNoteData {
  id: string
  bookId: string
  pageId: string
  pageNumber: number
  content: string
  color: string
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface BoardNoteData {
  id: string
  content: string
  color: string
  type: 'sticky' | 'card'
  x: number
  y: number
  width: number
  height: number
  rotation: number
  z: number
  /** Pinned notes cannot be moved (but writing is still allowed). */
  pinned: boolean
  deletedAt: string | null
  createdAt: string
  updatedAt: string
}

export const NOTE_COLORS = ['amber', 'rose', 'sage', 'sky', 'lilac', 'butter'] as const
export type NoteColor = (typeof NOTE_COLORS)[number]
