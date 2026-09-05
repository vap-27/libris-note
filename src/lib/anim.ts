export type Easing = (t: number) => number

export const linear: Easing = (t) => t
export const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3)
export const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeInOutQuad: Easing = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)

/** Mild back-out: overshoots ~4% then settles (page "settles onto" a value). */
export const easeOutBack: Easing = (t) => {
  const c1 = 1.2
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

export interface TweenHandle {
  cancel(): void
  /** jump straight to the end value and fire onComplete */
  finish(): void
}

export interface TweenOptions {
  from: number
  to: number
  duration: number
  easing?: Easing
  delay?: number
  onUpdate?: (value: number, t: number) => void
  onComplete?: () => void
}

/** requestAnimationFrame tween. Drives one scalar from `from` to `to`. */
export function tween(opts: TweenOptions): TweenHandle {
  const { from, to, duration, easing = linear, delay = 0, onUpdate, onComplete } = opts
  let raf = 0
  let done = false
  let started = false
  const start = performance.now() + delay

  const finish = () => {
    if (done) return
    done = true
    if (raf) cancelAnimationFrame(raf)
    onUpdate?.(to, 1)
    onComplete?.()
  }

  const tick = (now: number) => {
    if (done) return
    if (now < start) {
      raf = requestAnimationFrame(tick)
      return
    }
    if (!started) {
      started = true
    }
    const t = Math.min(1, (now - start) / Math.max(1, duration))
    const v = from + (to - from) * easing(t)
    onUpdate?.(v, t)
    if (t >= 1) {
      finish()
      return
    }
    raf = requestAnimationFrame(tick)
  }

  raf = requestAnimationFrame(tick)

  return {
    cancel() {
      if (done) return
      done = true
      cancelAnimationFrame(raf)
    },
    finish,
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

/** Format a date string or Date object as a compact relative label. */
export function relativeTime(iso: string | Date | undefined | null): string {
  if (!iso) return ''
  const then = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const min = 60_000
  if (diff < min) return 'just now'
  if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`
  if (diff < 7 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))}d ago`
  return new Date(then).toLocaleDateString()
}

