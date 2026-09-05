'use client'

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import PageFace from './PageFace'
import { tween, easeInOutCubic, easeOutCubic, clamp, sleep } from '@/lib/anim'
import type { Easing } from '@/lib/anim'
import type { PageData } from '@/lib/types'

export type StagePhase = 'front' | 'opening' | 'reading' | 'closing'
type Dir = 'fwd' | 'bwd'
type LeafMode = 'full' | 'flutter'

interface LeafItem {
  key: number
  sheet: number
  mode: LeafMode
  dir: Dir
  faceZ: number
}

interface Display {
  left: number
  right: number
}

export interface BookStageHandle {
  open(): void
  close(): void
  next(): void
  prev(): void
  goToPage(pageNumber: number, opts?: { fast?: boolean }): void
  setZoom(on: boolean): void
  isBusy(): boolean
}

interface BookStageProps {
  pages: PageData[]
  phase: StagePhase
  zoomed: boolean
  bookTitle: string
  bookSubtitle: string
  bookAuthor: string
  noteCounts: Record<number, number>
  onOpenStart(): void
  onOpened(): void
  onClosed(): void
  onDisplayChange(display: Display): void
  onOpenNotes(pageNumber: number): void
  /** ----- writable pages (resting faces only) ----- */
  onCreatePage?(pageNumber: number): void
  onSavePage?(pageId: string, patch: { content?: string; title?: string }): void
  onTogglePagePin?(page: PageData): void
  onDeletePage?(page: PageData): void
  focusId?: string | null
  /** ----- presence (Wave 1, all optional) ----- */
  identity?: { clientId: string; name: string; color: string } | null
  /** foreign edit leases by page number */
  pageLocks?: Map<number, { clientId: string; name: string; color: string }>
  onLockAcquire?: (page: PageData) => void
  onLockRelease?: (pageId: string) => void
}

function computeGeo() {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight
  const single = vw < 640
  const availH = Math.max(320, vh - 116)
  let pageW: number, pageH: number
  if (single) {
    pageW = Math.min(vw - 52, 420)
    pageH = Math.min(availH, pageW / 0.72)
    pageW = pageH * 0.72
    if (pageW > vw - 52) {
      pageW = vw - 52
      pageH = pageW / 0.72
    }
  } else {
    pageH = Math.min(availH, 800)
    pageW = Math.min(pageH * 0.72, vw * 0.465)
    pageH = pageW / 0.72
  }
  const closedH = single ? Math.min(vh * 0.55, 460) : Math.min(vh * 0.68, 530)
  const closedScale = clamp(closedH / pageH, 0.3, 0.95)
  return { single, pageW, pageH, closedScale, volumeW: single ? pageW : pageW * 2 }
}

const DEFAULT_GEO = { single: false, pageW: 500, pageH: 694.4, closedScale: 0.6, volumeW: 1000 }

const LEAF_TWEEN_MS = 700

/** Magnification applied while the reading zoom is on (pan via drag). */
const ZOOM_LEVEL = 1.45

/** Cover swing: a weighted board — it gathers itself, sweeps fast through
 *  the middle (edge-on, where it is lightest), then decelerates onto the
 *  table with a long soft landing. */
const easeCoverSwing: Easing = (t) => {
  if (t < 0.16) return 0.06 * (t / 0.16) * (t / 0.16)
  if (t < 0.72) {
    const u = (t - 0.16) / 0.56
    return 0.06 + 0.84 * easeInOutCubic(u)
  }
  const u = (t - 0.72) / 0.28
  return 0.9 + 0.1 * easeOutCubic(u)
}

/**
 * BookStage — a physically organised 3D book.
 *
 * The "volume" is the full open-book footprint (two pages wide in spread mode,
 * one page wide in single mode). The closed book occupies the right half; the
 * front cover rotates around the spine line (x = pageW, z = 0).
 *
 * Z plane map (viewer looks along -z):
 *   back cover -42 | gutter -6 | right static -2 | cover plane 0
 *   (front face +3, inside face -0.5) | left static +1 | leaf faces +2.6
 *
 * All transforms are written by a single rAF loop + rAF tweens (never CSS
 * transitions), so page state changes commit atomically with no flicker.
 */
const BookStage = forwardRef<BookStageHandle, BookStageProps>(function BookStage(props, ref) {
  const {
    pages, phase, zoomed, bookTitle, bookSubtitle, bookAuthor, noteCounts,
    onOpenStart, onOpened, onClosed, onDisplayChange, onOpenNotes,
    onCreatePage, onSavePage, onTogglePagePin, onDeletePage, focusId,
    identity, pageLocks, onLockAcquire, onLockRelease,
  } = props

  const [geo, setGeo] = useState(DEFAULT_GEO)
  const [display, setDisplay] = useState<Display>({ left: 0, right: 1 })
  const [leafStates, setLeafStates] = useState<LeafItem[]>([])
  const pageByNum = useMemo(() => {
    const m = new Map<number, PageData>()
    pages.forEach((p) => m.set(p.pageNumber, p))
    return m
  }, [pages])
  // Numbered max only: the flyleaf (0) must not skew sheet math.
  const maxPage = useMemo(() => {
    const numbered = pages.filter((p) => p.pageNumber > 0)
    return numbered.length ? Math.max(...numbered.map((p) => p.pageNumber)) : 0
  }, [pages])
  const sheetCount = Math.ceil(maxPage / 2)

  const sceneRef = useRef<HTMLDivElement>(null)
  const floatRef = useRef<HTMLDivElement>(null)
  const rigRef = useRef<HTMLDivElement>(null)
  const volumeRef = useRef<HTMLDivElement>(null)
  const shadowRef = useRef<HTMLDivElement>(null)
  const coverRef = useRef<HTMLDivElement>(null)
  const coverFaceRef = useRef<HTMLDivElement>(null)
  const coverFrontShadeRef = useRef<HTMLDivElement>(null)
  const coverBackShadeRef = useRef<HTMLDivElement>(null)
  const leftWrapRef = useRef<HTMLDivElement>(null)
  const leftShadeRef = useRef<HTMLDivElement>(null)
  const rightShadeRef = useRef<HTMLDivElement>(null)

  const leafRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const frontShadeRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const backShadeRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const cur = useRef({ cover: 0, scale: DEFAULT_GEO.closedScale, rotY: 24, rotX: 5, float: 0, floatAmp: 0, zoom: 1, panX: 0, panY: 0, lift: 0 })
  const tgt = useRef({ rotY: 24, rotX: 5, scaleK: 1 })
  const owned = useRef<Set<string>>(new Set())
  const phaseRef = useRef<StagePhase>(phase)
  const geoRef = useRef(geo)
  // Mirror latest props for animation/event callbacks. Effects run after
  // commit and before any handler can fire, so callbacks stay fresh without
  // render-time ref writes.
  useEffect(() => {
    phaseRef.current = phase
    geoRef.current = geo
  }, [phase, geo])

  const sheetRef = useRef(0)
  const busy = useRef(false)
  const pending = useRef<null | (() => void)>(null)
  const keyCounter = useRef(0)
  const mounted = useRef(false)
  const cbs = useRef({ onOpenStart, onOpened, onClosed, onDisplayChange })
  useEffect(() => {
    cbs.current = { onOpenStart, onOpened, onClosed, onDisplayChange }
  })

  const reduceMotion = () =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---------- reading zoom (magnify + pan; pages become read-only) ----------
  const zoomRef = useRef(false)
  useEffect(() => { zoomRef.current = zoomed }, [zoomed])

  const panBounds = () => {
    const g = geoRef.current
    const z = Math.max(1, cur.current.zoom)
    const maxX = Math.max(0, (g.volumeW * z - window.innerWidth) / 2 + 60)
    const maxY = Math.max(0, (g.pageH * z - window.innerHeight) / 2 + 60)
    return { maxX, maxY }
  }

  const setZoomLevel = (on: boolean) => {
    zoomRef.current = on
    const c = cur.current
    const dur = reduceMotion() ? 160 : 480
    tween({ from: c.zoom, to: on ? ZOOM_LEVEL : 1, duration: dur, easing: easeInOutCubic, onUpdate: (v) => { c.zoom = v } })
    tween({ from: c.panX, to: 0, duration: dur, easing: easeInOutCubic, onUpdate: (v) => { c.panX = v } })
    tween({ from: c.panY, to: 0, duration: dur, easing: easeInOutCubic, onUpdate: (v) => { c.panY = v } })
  }

  // ---------- geometry / resize ----------
  useLayoutEffect(() => {
    const compute = () => setGeo(computeGeo())
    compute()
    window.addEventListener('resize', compute)
    return () => window.removeEventListener('resize', compute)
  }, [])

  // reset paging when switching between spread/single
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // reset paging when switching between spread/single. When the reader is
  // mid-book, the current page is carried across (remapped to the new
  // geometry) instead of snapping home — resizing a window must never
  // throw away someone's place.
  const prevSingle = useRef<boolean | null>(null)
  useEffect(() => {
    // Deferred one tick so geometry remaps never setState synchronously in
    // the effect body; a breakpoint cross mid-flip still lands correctly
    // because flip commits read sheetRef at completion time.
    const t = setTimeout(() => {
      if (!mounted.current) return
      const was = prevSingle.current
      prevSingle.current = geo.single
      if (was === null || was === geo.single || phaseRef.current !== 'reading') {
        const home: Display = geo.single ? { left: -1, right: 1 } : { left: 0, right: 1 }
        sheetRef.current = geo.single ? 1 : 0
        setLeafStates([])
        setDisplay(home)
        cbs.current.onDisplayChange(home)
        return
      }
      const s = sheetRef.current
      if (geo.single) {
        // spread → single: the right page of the spread becomes the sheet
        const page = clamp(2 * s + 1, 1, maxPage + 1)
        sheetRef.current = page
        setLeafStates([])
        setDisplay({ left: -1, right: page })
        cbs.current.onDisplayChange({ left: -1, right: page })
      } else {
        // single → spread: the page settles onto its sheet
        const sheet = clamp(Math.floor(s / 2), 0, sheetCount)
        sheetRef.current = sheet
        setLeafStates([])
        setDisplay({ left: 2 * sheet, right: 2 * sheet + 1 })
        cbs.current.onDisplayChange({ left: 2 * sheet, right: 2 * sheet + 1 })
      }
    }, 0)
    return () => clearTimeout(t)
  }, [geo.single])

  // Safety net: if the book shrinks under the current display (delete /
  // sweep / restore applied without a navigation correction), pull back
  // inside while idle. The correction runs in a timeout callback (never a
  // sync setState-in-effect) and never fights an in-flight flip — those
  // commit their own display, and goToPage always clamps anyway.
  useEffect(() => {
    if (phase !== 'reading') return
    if (busy.current || leafStates.length > 0) return
    if (display.right <= 0 || display.right <= maxPage + 1) return
    const t = setTimeout(() => {
      if (busy.current || !mounted.current) return
      const single = geoRef.current.single
      const sheet = clamp(Math.floor((maxPage + 1) / 2), 0, Math.ceil(maxPage / 2))
      const fixed: Display = single
        ? { left: -1, right: maxPage + 1 }
        : { left: 2 * sheet, right: 2 * sheet + 1 }
      sheetRef.current = single ? fixed.right : sheet
      setDisplay(fixed)
      cbs.current.onDisplayChange(fixed)
    }, 0)
    return () => clearTimeout(t)
  }, [maxPage, leafStates.length, display, phase])

  // identity targets while open
  useEffect(() => {
    if (phase === 'opening' || phase === 'reading') {
      tgt.current.rotY = 0
      tgt.current.rotX = 0
      tgt.current.scaleK = 1
    } else {
      tgt.current.rotY = 24
      tgt.current.rotX = 5
      tgt.current.scaleK = 1
    }
  }, [phase])

  // ---------- render loop ----------
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    // Style write cache: once every value converges, the composed strings stop
    // changing and the loop stops touching the DOM at all — an idle frame
    // costs a dozen string compares instead of ~15 style writes. This is what
    // keeps the stage cheap on mobile while the book rests open.
    const cache = {
      rig: '', cover: '', glint: '', glintX: '', float: '',
      shadow: '', shadowO: '', leftO: '', cfs: '', cbs: '',
    }

    const loop = (now: number) => {
      const dt = Math.min(50, now - last)
      last = now
      const c = cur.current
      const t = tgt.current
      const k = 1 - Math.pow(0.0015, dt / 1000)

      const baseScale = phaseRef.current === 'front' ? geoRef.current.closedScale : 1
      const targetScale = baseScale * t.scaleK
      if (!owned.current.has('scale')) c.scale += (targetScale - c.scale) * k

      const floatTarget = phaseRef.current === 'front' || phaseRef.current === 'closing' ? 1 : 0
      if (!owned.current.has('float')) c.floatAmp += (floatTarget - c.floatAmp) * k
      c.float = Math.sin(now / 1100) * 7 * c.floatAmp

      if (rigRef.current) {
        const rig = `translateY(${c.lift.toFixed(2)}px) scale(${c.scale.toFixed(4)}) rotateX(${c.rotX.toFixed(2)}deg) rotateY(${c.rotY.toFixed(2)}deg)`
        if (rig !== cache.rig) {
          cache.rig = rig
          rigRef.current.style.transform = rig
        }
      }
      if (coverRef.current) {
        const cover = `rotateY(${c.cover.toFixed(2)}deg)`
        if (cover !== cache.cover) {
          cache.cover = cover
          coverRef.current.style.transform = cover
        }
      }
      // foil glint: intensity follows the rig tilt (bright at rest, fading as
      // the book presents), position sweeps across the cover as it swings
      if (coverFaceRef.current) {
        const glint = clamp(c.rotY / 24, 0, 1).toFixed(3)
        const gx = `${(22 + (Math.abs(c.cover) / 180) * 62).toFixed(1)}%`
        if (glint !== cache.glint) {
          cache.glint = glint
          coverFaceRef.current.style.setProperty('--glint', glint)
        }
        if (gx !== cache.glintX) {
          cache.glintX = gx
          coverFaceRef.current.style.setProperty('--glint-x', gx)
        }
      }
      if (floatRef.current) {
        const float = `translate(${c.panX.toFixed(1)}px, ${c.panY.toFixed(1)}px) translateY(${c.float.toFixed(2)}px) scale(${c.zoom.toFixed(4)})`
        if (float !== cache.float) {
          cache.float = float
          floatRef.current.style.transform = float
        }
      }
      if (shadowRef.current) {
        const s = c.scale
        const g = geoRef.current
        const offX = g.single ? 0 : g.pageW * 0.5 * s
        // the shadow reads the lift: the book rising off the desk softens and
        // drops its shadow; landing squeezes it tight and dark
        const liftSpread = Math.max(0, -c.lift) * 1.6
        const shadow = `translate(calc(-50% + ${offX.toFixed(1)}px), ${((g.pageH * s) / 2 + 18 - c.float * 0.6 + c.lift * 0.8).toFixed(1)}px) scale(${(s * 0.98 + 0.02 + liftSpread / 260).toFixed(3)})`
        const shadowO = clamp(0.5 * s + 0.1 - liftSpread / 130, 0.08, 0.55).toFixed(3)
        if (shadow !== cache.shadow) {
          cache.shadow = shadow
          shadowRef.current.style.transform = shadow
        }
        if (shadowO !== cache.shadowO) {
          cache.shadowO = shadowO
          shadowRef.current.style.opacity = shadowO
        }
      }
      if (leftWrapRef.current) {
        const gate = clamp((-c.cover - 100) / 55, 0, 1)
        const lo = gate.toFixed(3)
        if (lo !== cache.leftO) {
          cache.leftO = lo
          leftWrapRef.current.style.opacity = lo
          leftWrapRef.current.style.visibility = gate > 0.01 ? 'visible' : 'hidden'
        }
      }
      const cp = Math.min(1, Math.abs(c.cover) / 180)
      const wave = Math.sin(cp * Math.PI)
      if (coverFrontShadeRef.current) {
        const cfs = (wave * 0.42).toFixed(3)
        if (cfs !== cache.cfs) {
          cache.cfs = cfs
          coverFrontShadeRef.current.style.opacity = cfs
        }
      }
      if (coverBackShadeRef.current) {
        const cbs = (wave * 0.3).toFixed(3)
        if (cbs !== cache.cbs) {
          cache.cbs = cbs
          coverBackShadeRef.current.style.opacity = cbs
        }
      }

      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---------- shading ----------
  const applyShading = (key: number, angle: number) => {
    const p = Math.min(1, Math.abs(angle) / 180)
    const wave = Math.sin(p * Math.PI)
    const fs = frontShadeRefs.current.get(key)
    if (fs) {
      fs.style.opacity = (wave * 0.42).toFixed(3)
    }
    const bs = backShadeRefs.current.get(key)
    if (bs) {
      bs.style.opacity = (wave * 0.42).toFixed(3)
    }
    if (leftShadeRef.current) leftShadeRef.current.style.opacity = (p * p * 0.34).toFixed(3)
    if (rightShadeRef.current) rightShadeRef.current.style.opacity = (wave * 0.22).toFixed(3)
  }
  const restShading = () => {
    if (leftShadeRef.current) leftShadeRef.current.style.opacity = '0.16'
    if (rightShadeRef.current) rightShadeRef.current.style.opacity = '0.12'
  }
  /** Paper lands with a soft press: the shade under the arriving leaf flares
   *  for a beat and settles, like a page pressing down onto the stack. */
  const settleShading = (dir: Dir) => {
    const el = dir === 'fwd' ? rightShadeRef.current : leftShadeRef.current
    if (!el || reduceMotion()) return
    el.style.opacity = '0.5'
    tween({
      from: 0.5,
      to: dir === 'fwd' ? 0.12 : 0.16,
      duration: 300,
      easing: easeOutCubic,
      onUpdate: (v) => { el.style.opacity = v.toFixed(3) },
    })
  }
  const clearLeafShades = (keys: number[]) => {
    keys.forEach((k) => {
      const fs = frontShadeRefs.current.get(k)
      if (fs) fs.style.opacity = '0'
      const bs = backShadeRefs.current.get(k)
      if (bs) bs.style.opacity = '0'
    })
  }

  // ---------- leaf helpers ----------
  const leafFrontPage = (sheet: number) => (geo.single ? sheet : 2 * sheet - 1)
  const leafBackPage = (sheet: number) => (geo.single ? sheet + 1 : 2 * sheet)

  /**
   * Writes the clean single leaf transform around the spine hinge.
   */
  const setLeafAngle = (key: number, angle: number, dir: Dir = 'fwd') => {
    void dir
    const el = leafRefs.current.get(key)
    if (!el) return
    el.style.transform = `rotateY(${angle.toFixed(2)}deg)`
  }
  const registerLeaf = (key: number) => (el: HTMLDivElement | null) => {
    if (el) leafRefs.current.set(key, el)
    else leafRefs.current.delete(key)
  }
  const registerShade = (kind: 'front' | 'back', key: number) => (el: HTMLDivElement | null) => {
    const m = kind === 'front' ? frontShadeRefs : backShadeRefs
    if (el) m.current.set(key, el)
    else m.current.delete(key)
  }

  const applyDisplay = (d: Display, notify = true) => {
    setDisplay(d)
    if (notify) cbs.current.onDisplayChange(d)
  }

  const flushPending = () => {
    busy.current = false
    const p = pending.current
    pending.current = null
    p?.()
  }

  // ---------- flip / riffle ----------
  const flipTo = async (targetSheet: number, opts?: { fast?: boolean; keepBusy?: boolean }) => {
    const fast = opts?.fast ?? false
    const single = geoRef.current.single
    const s = sheetRef.current
    const fwd = targetSheet > s

    const leaves: { sheet: number; mode: LeafMode }[] = []
    if (single) {
      if (fwd) {
        for (let sh = s; sh < targetSheet; sh++) leaves.push({ sheet: sh, mode: sh === targetSheet - 1 ? 'full' : 'flutter' })
      } else {
        for (let sh = s - 1; sh >= targetSheet; sh--) leaves.push({ sheet: sh, mode: sh === targetSheet ? 'full' : 'flutter' })
      }
    } else {
      if (fwd) {
        for (let sh = s + 1; sh <= targetSheet; sh++) leaves.push({ sheet: sh, mode: sh === targetSheet ? 'full' : 'flutter' })
      } else {
        for (let sh = s; sh > targetSheet; sh--) leaves.push({ sheet: sh, mode: sh === targetSheet + 1 ? 'full' : 'flutter' })
      }
    }
    if (leaves.length === 0) {
      if (!opts?.keepBusy) flushPending()
      return
    }

    busy.current = true

    let startDisplay: Display
    let endDisplay: Display
    if (single) {
      startDisplay = { left: -1, right: fwd ? targetSheet : s }
      endDisplay = { left: -1, right: targetSheet }
    } else {
      startDisplay = fwd ? { left: 2 * s, right: 2 * targetSheet + 1 } : { left: 2 * targetSheet, right: 2 * s + 1 }
      endDisplay = { left: 2 * targetSheet, right: 2 * targetSheet + 1 }
    }
    applyDisplay(startDisplay)

    const keys: number[] = []
    const finalDuration = leaves.length === 1 ? (fast ? 260 : LEAF_TWEEN_MS) : fast ? 170 : 250
    const stepDuration = fast ? 95 : 145
    const stagger = fast ? 42 : 62

    for (let i = 0; i < leaves.length; i++) {
      const L = leaves[i]
      const key = ++keyCounter.current
      keys.push(key)
      const dir: Dir = fwd ? 'fwd' : 'bwd'
      const item: LeafItem = { key, sheet: L.sheet, mode: L.mode, dir, faceZ: 2.6 + i * 0.9 }
      setLeafStates((prev) => [...prev, item])

      const from = fwd ? 0 : -180
      const to = fwd ? -180 : 0
      const isFinal = i === leaves.length - 1

      tween({
        from,
        to,
        duration: isFinal ? finalDuration : stepDuration,
        delay: 30,
        easing: easeInOutCubic,
        onUpdate: (v) => {
          setLeafAngle(key, v, dir)
          if (isFinal && L.mode === 'full') applyShading(key, v)
        },
      })

      if (i < leaves.length - 1) await sleep(stagger)
    }

    await sleep(finalDuration + (fast ? 30 : 60))
    if (!mounted.current) return

    // atomic commit: remove all riffle leaves + swap the visible spread in one paint
    setLeafStates((prev) => prev.filter((l) => !keys.includes(l.key)))
    applyDisplay(endDisplay)
    sheetRef.current = targetSheet
    restShading()
    settleShading(fwd ? 'fwd' : 'bwd')
    clearLeafShades(keys)

    if (!opts?.keepBusy) flushPending()
  }
  const flipToRef = useRef(flipTo)
  useEffect(() => {
    flipToRef.current = flipTo
  })

  // ---------- open / close ----------
  /** A breath of pages: as the cover lands, the top of the right stack
   *  stirs, lifts a few degrees, and settles back — the air the cover moved. */
  const pageBreath = (delayMs: number) => {
    if (maxPage < 1) return
    const key = ++keyCounter.current
    const item: LeafItem = { key, sheet: 1, mode: 'flutter', dir: 'fwd', faceZ: 2.2 }
    setLeafStates((prev) => [...prev, item])
    tween({
      from: 0, to: -32, duration: 220, delay: delayMs, easing: easeOutCubic,
      onUpdate: (v) => setLeafAngle(key, v, 'fwd'),
      onComplete: () => {
        tween({
          from: -32, to: 0, duration: 380, easing: easeInOutCubic,
          onUpdate: (v) => setLeafAngle(key, v, 'fwd'),
          onComplete: () => {
            if (!mounted.current) return
            setLeafStates((prev) => prev.filter((l) => l.key !== key))
          },
        })
      },
    })
  }

  const startOpen = () => {
    if (busy.current || phaseRef.current !== 'front') return
    busy.current = true
    cbs.current.onOpenStart()
    owned.current.add('cover')
    owned.current.add('scale')
    owned.current.add('rotY')
    owned.current.add('rotX')
    owned.current.add('float')
    owned.current.add('lift')
    const c = cur.current
    const rm = reduceMotion()

    // 1 · the book gathers itself and lifts off the desk
    tween({
      from: c.lift, to: -16, duration: rm ? 120 : 380, easing: easeOutCubic,
      onUpdate: (v) => { c.lift = v },
    })

    // 2 · the cover swings open with a weighted arc
    const swingDur = rm ? 240 : 1240
    tween({
      from: c.cover, to: -180, duration: swingDur, delay: rm ? 0 : 140, easing: easeCoverSwing,
      onUpdate: (v) => { c.cover = v },
      onComplete: () => {
        owned.current.delete('cover')
        // 4 · the landing: a small dip onto the table, then rest
        tween({
          from: c.lift, to: 5, duration: rm ? 60 : 170, easing: easeInOutCubic,
          onUpdate: (v) => { c.lift = v },
          onComplete: () => {
            tween({
              from: c.lift, to: 0, duration: rm ? 80 : 210, easing: easeOutCubic,
              onUpdate: (v) => { c.lift = v },
              onComplete: () => { owned.current.delete('lift') },
            })
          },
        })
        settleShading('fwd')
        busy.current = false
        flushPending()
        cbs.current.onOpened()
      },
    })

    // 3 · the rig presents: rotation eases in step with the swing, the scale
    //     lands slightly past 1 and breathes back (the volume settling)
    tween({
      from: c.rotY, to: 0, duration: rm ? 200 : 980, delay: rm ? 0 : 140, easing: easeOutCubic,
      onUpdate: (v) => { c.rotY = v },
      onComplete: () => { owned.current.delete('rotY') },
    })
    tween({
      from: c.rotX, to: 0, duration: rm ? 200 : 900, delay: rm ? 0 : 140, easing: easeOutCubic,
      onUpdate: (v) => { c.rotX = v },
      onComplete: () => { owned.current.delete('rotX') },
    })
    tween({
      from: c.scale, to: 1.03, duration: rm ? 220 : 1160, delay: rm ? 0 : 140, easing: easeOutCubic,
      onUpdate: (v) => { c.scale = v },
      onComplete: () => {
        tween({
          from: c.scale, to: 1, duration: rm ? 60 : 320, easing: easeOutCubic,
          onUpdate: (v) => { c.scale = v },
          onComplete: () => { owned.current.delete('scale') },
        })
      },
    })
    tween({
      from: c.floatAmp, to: 0, duration: 420,
      onUpdate: (v) => { c.floatAmp = v },
      onComplete: () => { owned.current.delete('float') },
    })

    // 5 · displaced air: the pages stir just before the cover comes down
    if (!rm) pageBreath(1060)
  }

  const startClose = async () => {
    if (busy.current) {
      // a flip or drag is still running — queue the close; the pending slot
      // is flushed when it lands, and the retried close proceeds then
      pending.current = () => { void startClose() }
      return
    }
    if (phaseRef.current !== 'reading' && phaseRef.current !== 'closing') return
    busy.current = true
    // magnification off first — the book must shrink home from its resting size
    if (zoomRef.current || cur.current.zoom > 1.001) {
      zoomRef.current = false
      const c = cur.current
      tween({ from: c.zoom, to: 1, duration: 300, easing: easeInOutCubic, onUpdate: (v) => { c.zoom = v } })
      tween({ from: c.panX, to: 0, duration: 300, easing: easeInOutCubic, onUpdate: (v) => { c.panX = v } })
      tween({ from: c.panY, to: 0, duration: 300, easing: easeInOutCubic, onUpdate: (v) => { c.panY = v } })
    }
    const home = geoRef.current.single ? 1 : 0
    if (sheetRef.current !== home) {
      await flipToRef.current(home, { fast: true, keepBusy: true })
      if (!mounted.current) return
      await sleep(70)
    }
    busy.current = true
    const c = cur.current
    owned.current.add('cover')
    owned.current.add('scale')
    owned.current.add('rotY')
    owned.current.add('rotX')
    owned.current.add('float')

    tween({
      from: c.cover, to: 0, duration: reduceMotion() ? 240 : 980, delay: 60, easing: easeInOutCubic,
      onUpdate: (v) => { c.cover = v },
      onComplete: () => {
        owned.current.delete('cover')
        busy.current = false
        flushPending()
        cbs.current.onClosed()
      },
    })
    // the closing lift: the book rises slightly as it shuts, then rests
    tween({
      from: c.lift, to: -8, duration: reduceMotion() ? 80 : 420, easing: easeOutCubic,
      onUpdate: (v) => { c.lift = v },
      onComplete: () => {
        tween({
          from: c.lift, to: 0, duration: reduceMotion() ? 80 : 320, easing: easeOutCubic,
          onUpdate: (v) => { c.lift = v },
        })
      },
    })
    tween({
      from: c.scale, to: geoRef.current.closedScale, duration: reduceMotion() ? 240 : 1140, easing: easeInOutCubic,
      onUpdate: (v) => { c.scale = v },
      onComplete: () => { owned.current.delete('scale') },
    })
    tween({
      from: c.rotY, to: 24, duration: 700, easing: easeInOutCubic,
      onUpdate: (v) => { c.rotY = v },
      onComplete: () => { owned.current.delete('rotY') },
    })
    tween({
      from: c.rotX, to: 5, duration: 700, easing: easeInOutCubic,
      onUpdate: (v) => { c.rotX = v },
      onComplete: () => { owned.current.delete('rotX') },
    })
    tween({
      from: c.floatAmp, to: 1, duration: 600,
      onUpdate: (v) => { c.floatAmp = v },
      onComplete: () => { owned.current.delete('float') },
    })
  }

  // ---------- pointer interaction ----------
  const maxSheet = () => (geoRef.current.single ? maxPage + 1 : sheetCount)

  const withinBookArea = (x: number, y: number) => {
    const vol = volumeRef.current
    if (!vol) return false
    const r = vol.getBoundingClientRect()
    const pad = 44
    const xMin = geoRef.current.single ? r.left - pad : r.left + r.width * 0.42 - pad
    return x > xMin && x < r.right + pad && y > r.top - pad && y < r.bottom + pad
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (phaseRef.current !== 'front') return
    const hover = withinBookArea(e.clientX, e.clientY)
    tgt.current.rotY = hover ? 12 : 24
    tgt.current.rotX = hover ? 2.5 : 5
    tgt.current.scaleK = hover ? 1.03 : 1
  }

  const onPointerLeave = () => {
    if (phaseRef.current !== 'front') return
    tgt.current.rotY = 24
    tgt.current.rotX = 5
    tgt.current.scaleK = 1
  }

  const onWheel = (e: React.WheelEvent) => {
    if (phaseRef.current !== 'reading' || zoomRef.current) return
    const target = e.target as HTMLElement
    const paper = target.closest('.page-paper')
    const ruledInput = paper?.querySelector<HTMLElement>('.page-ruled-input')
    if (ruledInput) {
      ruledInput.scrollTop += e.deltaY
    }
  }

  const drag = useRef<{
    active: boolean
    pan: boolean
    key: number
    dir: Dir
    sheet: number
    startX: number
    startY: number
    lastX: number
    lastY: number
    lastAngle: number
    lastT: number
    vel: number
  } | null>(null)
  const dragRaf = useRef(0)

  const mountDragLeaf = (dir: Dir) => {
    const single = geoRef.current.single
    const s = sheetRef.current
    let sheet: number
    let startDisplay: Display
    if (dir === 'fwd') {
      if (s >= maxSheet()) return null
      sheet = single ? s : s + 1
      startDisplay = single ? { left: -1, right: sheet + 1 } : { left: 2 * s, right: 2 * (s + 1) + 1 }
    } else {
      if (s <= (single ? 1 : 0)) return null
      sheet = single ? s - 1 : s
      startDisplay = single ? { left: -1, right: s } : { left: 2 * (s - 1), right: 2 * s + 1 }
    }
    const key = ++keyCounter.current
    const item: LeafItem = { key, sheet, mode: 'full', dir, faceZ: 2.6 }
    setLeafStates((prev) => [...prev, item])
    applyDisplay(startDisplay)
    busy.current = true
    return { key, sheet }
  }

  /** Per-frame drag driver: writes the leaf angle every animation frame, so it
   *  is immune to React commit timing (the leaf mounts asynchronously after
   *  the first pointermove) and to any style re-writes. */
  const startDragLoop = () => {
    const tick = () => {
      const d = drag.current
      if (!d || !d.active) {
        dragRaf.current = 0
        return
      }
      const pw = geoRef.current.pageW
      const raw = ((d.lastX - d.startX) / pw) * 180
      const angle = d.dir === 'fwd' ? clamp(raw, -180, 0) : clamp(-180 + raw, -180, 0)
      const now = performance.now()
      const dt = Math.max(1, now - d.lastT)
      if (angle !== d.lastAngle) {
        d.vel = 0.7 * d.vel + 0.3 * ((angle - d.lastAngle) / dt)
        d.lastAngle = angle
        d.lastT = now
      }
      setLeafAngle(d.key, angle, d.dir)
      applyShading(d.key, angle)
      dragRaf.current = requestAnimationFrame(tick)
    }
    if (!dragRaf.current) dragRaf.current = requestAnimationFrame(tick)
  }

  const stopDragLoop = () => {
    if (dragRaf.current) {
      cancelAnimationFrame(dragRaf.current)
      dragRaf.current = 0
    }
  }

  const onDragMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return

    if (!d.active) {
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      // Need clear drag intent (hold then slide)
      if (Math.hypot(dx, dy) < 14) return
      // If predominantly vertical gesture, don't hijack as page turn
      if (Math.abs(dy) > Math.abs(dx) * 1.3) return

      // while the reading zoom is on, a drag slides the magnified page
      // across the desk instead of turning it
      if (zoomRef.current) {
        d.active = true
        d.pan = true
        d.lastX = e.clientX
        d.lastY = e.clientY
        return
      }

      const vol = volumeRef.current
      if (!vol) return
      const rect = vol.getBoundingClientRect()
      const rel = (d.startX - rect.left) / Math.max(1, rect.width)
      const single = geoRef.current.single

      // Swiping left (dx < -6) turns forward; swiping right (dx > 6) turns backward
      let dir: Dir
      if (dx < -6) {
        dir = 'fwd'
      } else if (dx > 6) {
        dir = 'bwd'
      } else {
        dir = single ? (d.startX > rect.left + rect.width * 0.25 ? 'fwd' : 'bwd') : (rel > 0.5 ? 'fwd' : 'bwd')
      }

      const m = mountDragLeaf(dir)
      if (!m) {
        drag.current = null
        return
      }
      d.active = true
      d.pan = false
      d.dir = dir
      d.key = m.key
      d.sheet = m.sheet
      d.lastAngle = dir === 'fwd' ? 0 : -180
      d.lastT = performance.now()
      startDragLoop()
    }

    if (d.pan) {
      const { maxX, maxY } = panBounds()
      const c = cur.current
      c.panX = clamp(c.panX + (e.clientX - d.lastX), -maxX, maxX)
      c.panY = clamp(c.panY + (e.clientY - d.lastY), -maxY, maxY)
      d.lastX = e.clientX
      d.lastY = e.clientY
      return
    }

    d.lastX = e.clientX
  }

  const onDragUp = (e: PointerEvent) => {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragUp)
    window.removeEventListener('pointercancel', onDragUp)
    stopDragLoop()
    const d = drag.current
    drag.current = null
    if (!d) return

    // zoom pan: already applied straight to the rig — nothing to commit
    if (d.pan) return

    if (!d.active) {
      const vol = volumeRef.current
      if (!vol) return

      const targetEl = e.target as HTMLElement | null
      // 1. If clicking directly on an interactive element (textarea, input, button, a), leave alone and never turn!
      if (targetEl?.closest('textarea, input, button, a, [role="button"]')) {
        return
      }

      const rect = vol.getBoundingClientRect()
      const rel = (e.clientX - rect.left) / Math.max(1, rect.width)
      const single = geoRef.current.single

      // Tap / Click: ONLY flip if the click occurred on the outer left or right edge!
      // Must also be within middle vertical band, not top header (tools/title) or bottom footer (notes)
      const inVerticalTurnZone = e.clientY >= rect.top + 60 && e.clientY <= rect.bottom - 60
      const isLeftEdge = inVerticalTurnZone && ((e.clientX - rect.left) <= 56 || rel <= (single ? 0.14 : 0.08))
      const isRightEdge = inVerticalTurnZone && ((rect.right - e.clientX) <= 56 || rel >= (single ? 0.86 : 0.92))

      if (isRightEdge) {
        const s = sheetRef.current
        const target = s + 1
        if (target <= maxSheet()) {
          flipToRef.current(target)
        }
        return
      }

      if (isLeftEdge) {
        const s = sheetRef.current
        const target = s - 1
        if (target >= (single ? 1 : 0)) {
          flipToRef.current(target)
        }
        return
      }

      // If clicked on paper margin/padding outside inputs, focus the page's body textarea (not title)
      const clickedPaper = targetEl?.closest('.page-paper') || (rel > 0.5 ? vol.querySelector('.static-page--right .page-paper') : vol.querySelector('.static-page--left .page-paper'))
      if (clickedPaper) {
        const textarea = clickedPaper.querySelector<HTMLTextAreaElement>('.page-ruled-input')
        textarea?.focus()
      }
      return
    }

    const { key, dir, sheet, lastAngle, vel } = d
    const single = geoRef.current.single
    const fwd = dir === 'fwd'
    const shouldComplete = fwd ? vel < -0.28 || lastAngle < -95 : vel > 0.28 || lastAngle > -85
    const endAngle = fwd ? -180 : 0
    const homeAngle = fwd ? 0 : -180
    const target = fwd ? sheetRef.current + 1 : sheetRef.current - 1
    const remaining = Math.abs(endAngle - lastAngle)
    const speed = Math.max(0.25, Math.abs(vel))
    const dur = clamp(remaining / speed, 130, 480)

    tween({
      from: lastAngle,
      to: shouldComplete ? endAngle : homeAngle,
      duration: shouldComplete ? dur : 320,
      easing: shouldComplete ? easeOutCubic : easeInOutCubic,
      onUpdate: (v) => {
        setLeafAngle(key, v, dir)
        applyShading(key, v)
      },
      onComplete: () => {
        if (!mounted.current) return
        setLeafStates((prev) => prev.filter((l) => l.key !== key))
        if (shouldComplete) {
          const endDisplay: Display = single
            ? { left: -1, right: fwd ? sheet + 1 : sheet }
            : { left: 2 * target, right: 2 * target + 1 }
          applyDisplay(endDisplay)
          sheetRef.current = target
        } else {
          const s = sheetRef.current
          const revert: Display = single
            ? { left: -1, right: fwd ? sheet : sheet + 1 }
            : { left: 2 * s, right: 2 * s + 1 }
          applyDisplay(revert)
        }
        restShading()
        clearLeafShades([key])
        settleShading(fwd ? 'fwd' : 'bwd')
        flushPending()
      },
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (phaseRef.current === 'front') {
      if (withinBookArea(e.clientX, e.clientY)) startOpen()
      return
    }
    if (phaseRef.current !== 'reading' || busy.current) return
    const target = e.target as HTMLElement
    const interactive = target.closest('button, input, textarea, a')
    // while the reading zoom is on, the whole page is a pan surface — the
    // read-only paper must still carry the drag, not swallow it
    if (interactive && !zoomRef.current) return
    drag.current = {
      active: false, pan: false, key: 0, dir: 'fwd', sheet: 0,
      startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
      lastAngle: 0, lastT: performance.now(), vel: 0,
    }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragUp)
    window.addEventListener('pointercancel', onDragUp)
  }

  // ---------- imperative API ----------
  const actions = useRef({ startOpen, startClose, setZoomLevel })
  useEffect(() => {
    actions.current = { startOpen, startClose, setZoomLevel }
  })

  useImperativeHandle(ref, () => ({
    open: () => actions.current.startOpen(),
    close: () => actions.current.startClose(),
    next: () => {
      const run = () => {
        if (phaseRef.current !== 'reading') return
        const t = sheetRef.current + 1
        if (t <= maxSheet()) flipToRef.current(t)
      }
      if (busy.current) { pending.current = run; return }
      run()
    },
    prev: () => {
      const run = () => {
        if (phaseRef.current !== 'reading') return
        const t = sheetRef.current - 1
        if (t >= (geoRef.current.single ? 1 : 0)) flipToRef.current(t)
      }
      if (busy.current) { pending.current = run; return }
      run()
    },
    goToPage: (pageNumber: number, opts?: { fast?: boolean }) => {
      const run = () => {
        const single = geoRef.current.single
        const target = single
          ? clamp(pageNumber, 1, maxPage + 1)
          : clamp(Math.floor(pageNumber / 2), 0, sheetCount)
        if (target !== sheetRef.current) flipToRef.current(target, opts)
      }
      if (busy.current) { pending.current = run; return }
      run()
    },
    setZoom: (on: boolean) => actions.current.setZoomLevel(on),
    isBusy: () => busy.current,
  }))

  // ---------- render ----------
  return (
    <div
      ref={sceneRef}
      className={`book-stage phase-${phase} ${geo.single ? 'single' : 'spread'} ${zoomed ? 'book-stage--zoomed' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onWheel={onWheel}
      role="img"
      aria-label={`3D book: ${bookTitle}`}
    >
      <div className="book-shadow" ref={shadowRef} aria-hidden="true" />
      <div className="book-float" ref={floatRef}>
        <div className="book-rig" ref={rigRef} style={{ width: geo.volumeW, height: geo.pageH }}>
          {/* font-size snapped to half-px: fractional em roots blur every glyph
              on the page (worst on high-DPR phones). */}
          <div
            className="book-volume"
            ref={volumeRef}
            style={{ width: geo.volumeW, height: geo.pageH, fontSize: `${Math.round(geo.pageW * 0.0315 * 2) / 2}px` }}
          >
            {/* back cover plate */}
            <div className="cover-plate" aria-hidden="true" />

            {/* gutter — fold shadow between open pages */}
            {!geo.single && <div className="book-gutter" aria-hidden="true" />}

            {/* page block — the closed stack of unturned pages */}
            <div className="page-block" aria-hidden="true">
              <div className="page-block-edge page-block-edge--right" />
              <div className="page-block-edge page-block-edge--top" />
              <div className="page-block-edge page-block-edge--bottom" />
            </div>

            {/* static right page */}
            <div className="static-page static-page--right">
              <PageFace
                page={pageByNum.get(display.right) ?? null}
                pageNumber={display.right}
                noteCount={noteCounts[display.right] ?? 0}
                onOpenNotes={phase === 'reading' ? onOpenNotes : undefined}
                readOnly={zoomed}
                onCreatePage={phase === 'reading' ? onCreatePage : undefined}
                onSavePage={phase === 'reading' ? onSavePage : undefined}
                onTogglePagePin={phase === 'reading' ? onTogglePagePin : undefined}
                onDeletePage={phase === 'reading' ? onDeletePage : undefined}
                focusId={focusId}
                identity={identity}
                lockedBy={pageLocks?.get(display.right) ?? null}
                onLockAcquire={phase === 'reading' ? onLockAcquire : undefined}
                onLockRelease={onLockRelease}
              />
              <div className="static-shade static-shade--right" ref={rightShadeRef} aria-hidden="true" />
            </div>

            {/* static left page (spread mode) */}
            {!geo.single && (
              <div className="static-page static-page--left" ref={leftWrapRef}>
                <PageFace
                  page={display.left >= 0 ? pageByNum.get(display.left) ?? null : null}
                  pageNumber={display.left}
                  noteCount={noteCounts[display.left] ?? 0}
                  onOpenNotes={phase === 'reading' ? onOpenNotes : undefined}
                  readOnly={zoomed}
                  onCreatePage={phase === 'reading' ? onCreatePage : undefined}
                  onSavePage={phase === 'reading' ? onSavePage : undefined}
                  onTogglePagePin={phase === 'reading' ? onTogglePagePin : undefined}
                  onDeletePage={phase === 'reading' ? onDeletePage : undefined}
                  focusId={focusId}
                  identity={identity}
                  lockedBy={display.left >= 0 ? (pageLocks?.get(display.left) ?? null) : null}
                  onLockAcquire={phase === 'reading' ? onLockAcquire : undefined}
                  onLockRelease={onLockRelease}
                />
                <div className="static-shade static-shade--left" ref={leftShadeRef} aria-hidden="true" />
              </div>
            )}

            {/* spine with raised leather bands */}
            <div className="book-spine" aria-hidden="true">
              <span className="spine-band" />
              <span className="spine-rule spine-rule--top" />
              <span className="spine-title">{bookTitle}</span>
              <span className="spine-rule spine-rule--bottom" />
              <span className="spine-band spine-band--mid" />
            </div>

            {/* flipping leaves */}
            {leafStates.map((l) => {
              const fp = leafFrontPage(l.sheet)
              const bp = leafBackPage(l.sheet)
              return (
                <div
                  key={l.key}
                  className={`leaf leaf--${l.mode} leaf--${l.dir}`}
                  ref={registerLeaf(l.key)}
                  style={{ transform: `rotateY(${l.dir === 'fwd' ? 0 : -180}deg)` }}
                >
                  <div className="leaf-edge" aria-hidden="true" />
                  <div className="leaf-face leaf-face--front" style={{ transform: `translateZ(${l.faceZ}px)` }}>
                    {l.mode === 'full' ? (
                      <PageFace page={pageByNum.get(fp) ?? null} pageNumber={fp} frozen readOnly />
                    ) : (
                      <FlutterFace pageNumber={fp} />
                    )}
                    <div className="leaf-shade leaf-shade--front" ref={registerShade('front', l.key)} aria-hidden="true" />
                  </div>
                  <div className="leaf-face leaf-face--back" style={{ transform: `rotateY(180deg) translateZ(${l.faceZ}px)` }}>
                    {l.mode === 'full' ? (
                      <PageFace page={pageByNum.get(bp) ?? null} pageNumber={bp} frozen readOnly />
                    ) : (
                      <FlutterFace pageNumber={bp} />
                    )}
                    <div className="leaf-shade leaf-shade--back" ref={registerShade('back', l.key)} aria-hidden="true" />
                  </div>
                </div>
              )
            })}

            {/* front cover */}
            <div className="book-cover" ref={coverRef}>
              <div className="cover-face cover-face--front leather" ref={coverFaceRef}>
                <div className="cover-frame">
                  <span className="cover-corner cover-corner--tl" aria-hidden="true" />
                  <span className="cover-corner cover-corner--tr" aria-hidden="true" />
                  <span className="cover-corner cover-corner--bl" aria-hidden="true" />
                  <span className="cover-corner cover-corner--br" aria-hidden="true" />
                  <div className="cover-sheen" aria-hidden="true" />
                  <span className="cover-ornament" aria-hidden="true">&#10086;</span>
                  <h2 className="cover-title">{bookTitle}</h2>
                  <span className="cover-rule" aria-hidden="true" />
                  <span className="cover-subtitle">{bookSubtitle}</span>
                  {bookAuthor ? (
                    <span className="cover-author">{bookAuthor}</span>
                  ) : null}
                </div>
                <div className="cover-shade cover-shade--front" ref={coverFrontShadeRef} aria-hidden="true" />
              </div>
              <div className="cover-face cover-face--back leather">
                <div className="cover-inside" aria-hidden="true" />
                <div className="cover-shade cover-shade--back" ref={coverBackShadeRef} aria-hidden="true" />
              </div>
            </div>

            {/* Edge click-to-turn targets: right and left edges */}
            {phase === 'reading' && !zoomed && (
              <>
                <button
                  type="button"
                  className="book-edge-zone book-edge-zone--left"
                  onClick={(e) => {
                    e.stopPropagation()
                    const s = sheetRef.current
                    const target = s - 1
                    if (target >= (geo.single ? 1 : 0)) flipToRef.current(target)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label="Previous page (click left edge to turn)"
                  title="Previous page (click left edge to turn)"
                >
                  <span className="book-edge-zone-hint book-edge-zone-hint--left" aria-hidden="true">‹</span>
                </button>
                <button
                  type="button"
                  className="book-edge-zone book-edge-zone--right"
                  onClick={(e) => {
                    e.stopPropagation()
                    const s = sheetRef.current
                    const target = s + 1
                    if (target <= maxSheet()) flipToRef.current(target)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label="Next page (click right edge to turn)"
                  title="Next page (click right edge to turn)"
                >
                  <span className="book-edge-zone-hint book-edge-zone-hint--right" aria-hidden="true">›</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

function FlutterFace({ pageNumber }: { pageNumber: number }) {
  return (
    <div className="page-paper page-paper--flutter">
      <span className="flutter-num">{pageNumber > 0 ? pageNumber : ''}</span>
      <div className="flutter-lines" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <span key={i} style={{ width: `${86 - (i % 3) * 14}%` }} />
        ))}
      </div>
    </div>
  )
}

export default BookStage
