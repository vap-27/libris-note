import { dbUsers } from './users-db'
import {
  normalizeName,
  normalizePin,
  isLeaseLive,
  PRESENCE_COLORS,
  LEASE_TTL_MS,
} from './identity'
import { makeSalt, hashPin, verifyPin } from './identity-server'

/**
 * Users store (identity work): TiDB cluster `users_db` holding ONLY claimed
 * display names/PIN hashes, presence heartbeats, and page leases.
 * Nothing here is a backup; nothing here is book content.
 * (Previously a separate Turso database — Turso is fully decommissioned.)
 */

export function isUsrinfoConfigured(): boolean {
  return Boolean(process.env.USERS_DATABASE_URL)
}

/** Idempotent no-op kept for existing call sites: schema is managed by DDL (see ddl note in prisma/schema-users.prisma). */
export async function initUsrinfoTables(): Promise<void> {
  return
}

/** Presence is per-tab; a tab unread for 3 heartbeats is gone. */
export const PRESENCE_TTL_MS = 30_000

export interface PresenceUser {
  clientId: string
  tabId: string
  name: string
  color: string
  pageId: string | null
  activity: 'editing' | 'viewing'
  updatedAt: string
}

export interface PageLock {
  pageId: string
  clientId: string
  name: string
  color: string
  updatedAt: string
}

function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[h % PRESENCE_COLORS.length]
}

function toIso(d: Date): string {
  return d.toISOString()
}

/** Claim a display name with a PIN. Throws 'Name is taken' or validation text. */
export async function claimIdentity(
  rawName: unknown,
  rawPin: unknown
): Promise<{ name: string; color: string }> {
  const name = normalizeName(rawName)
  if (!name) throw new Error('Pick a name with at least 2 characters')
  const pin = normalizePin(rawPin)
  if (!pin) throw new Error('PIN must be 4–8 digits')
  const existing = await dbUsers.identity.findUnique({
    where: { name },
    select: { name: true },
  })
  if (existing) {
    throw new Error('Name is taken — verify with its PIN instead')
  }
  const salt = makeSalt()
  const color = colorForName(name)
  try {
    await dbUsers.identity.create({
      data: { name, pinHash: hashPin(pin, salt), salt, color },
    })
  } catch {
    // Lost a race with another claimant for the same name.
    throw new Error('Name is taken — verify with its PIN instead')
  }
  return { name, color }
}

/** Reclaim a name on a fresh browser. Throws 'Unknown name or wrong PIN'. */
export async function verifyIdentity(
  rawName: unknown,
  rawPin: unknown
): Promise<{ name: string; color: string }> {
  const name = normalizeName(rawName)
  const pin = normalizePin(rawPin)
  if (!name || !pin) throw new Error('Unknown name or wrong PIN')
  const row = await dbUsers.identity.findUnique({ where: { name } })
  if (!row || !verifyPin(pin, row.salt, row.pinHash)) {
    throw new Error('Unknown name or wrong PIN')
  }
  return { name, color: row.color || colorForName(name) }
}

/** Heartbeat upsert + stale-tab prune. Never throws (presence is advisory). */
export async function touchPresence(p: {
  clientId: string
  tabId: string
  name: string
  color: string
  pageId: string | null
  activity: 'editing' | 'viewing'
}): Promise<void> {
  try {
    const now = new Date()
    await dbUsers.presence.upsert({
      where: { clientId_tabId: { clientId: p.clientId, tabId: p.tabId } },
      create: {
        clientId: p.clientId,
        tabId: p.tabId,
        name: p.name,
        color: p.color,
        pageId: p.pageId,
        activity: p.activity,
        updatedAt: now,
      },
      update: {
        name: p.name,
        color: p.color,
        pageId: p.pageId,
        activity: p.activity,
        updatedAt: now,
      },
    })
    const cutoff = new Date(Date.now() - PRESENCE_TTL_MS)
    await dbUsers.presence.deleteMany({ where: { updatedAt: { lt: cutoff } } }).catch(() => {})
  } catch (err) {
    console.warn('[presence] heartbeat failed:', err)
  }
}

function mapPresence(r: {
  clientId: string
  tabId: string
  name: string
  color: string
  pageId: string | null
  activity: string
  updatedAt: Date
}): PresenceUser {
  return {
    clientId: r.clientId,
    tabId: r.tabId,
    name: r.name,
    color: r.color,
    pageId: r.pageId,
    activity: r.activity === 'editing' ? 'editing' : 'viewing',
    updatedAt: toIso(r.updatedAt),
  }
}

/** Live users (stale pruned). Never throws. */
export async function listPresence(): Promise<PresenceUser[]> {
  try {
    const cutoff = new Date(Date.now() - PRESENCE_TTL_MS)
    await dbUsers.presence.deleteMany({ where: { updatedAt: { lt: cutoff } } }).catch(() => {})
    const rows = await dbUsers.presence.findMany({ orderBy: { updatedAt: 'desc' } })
    return rows.map(mapPresence)
  } catch (err) {
    console.warn('[presence] list failed:', err)
    return []
  }
}

function lockIsLive(updatedAt: Date): boolean {
  return isLeaseLive(updatedAt.getTime(), Date.now(), LEASE_TTL_MS)
}

function mapLock(r: {
  pageId: string
  clientId: string
  name: string
  color: string
  updatedAt: Date
}): PageLock {
  return {
    pageId: r.pageId,
    clientId: r.clientId,
    name: r.name,
    color: r.color,
    updatedAt: toIso(r.updatedAt),
  }
}

/**
 * Acquire (or confirm) the edit lease on a page. Atomic enough for this
 * scale: single SELECT then conditional write; concurrent acquirers race and
 * exactly one wins because the second sees the first's fresh row.
 */
export async function acquirePageLock(
  pageId: string,
  clientId: string,
  name: string,
  color: string
): Promise<{ acquired: boolean; holder: PageLock }> {
  const now = new Date()
  const row = await dbUsers.pageLock.findUnique({ where: { pageId } })
  if (!row || !lockIsLive(row.updatedAt) || row.clientId === clientId) {
    const saved = await dbUsers.pageLock.upsert({
      where: { pageId },
      create: { pageId, clientId, name, color, updatedAt: now },
      update: { clientId, name, color, updatedAt: now },
    })
    return { acquired: true, holder: mapLock(saved) }
  }
  return { acquired: false, holder: mapLock(row) }
}

/** Release only your own lease. Never throws. */
export async function releasePageLock(pageId: string, clientId: string): Promise<void> {
  try {
    await dbUsers.pageLock.deleteMany({ where: { pageId, clientId } })
  } catch (err) {
    console.warn('[presence] release failed:', err)
  }
}

/** Keep your own leases alive (called on heartbeat). Never throws. */
export async function refreshOwnLocks(clientId: string): Promise<void> {
  try {
    await dbUsers.pageLock.updateMany({
      where: { clientId },
      data: { updatedAt: new Date() },
    })
  } catch (err) {
    console.warn('[presence] refresh failed:', err)
  }
}

/** Live leases (expired pruned). Never throws. */
export async function listPageLocks(): Promise<PageLock[]> {
  try {
    const cutoff = new Date(Date.now() - LEASE_TTL_MS)
    await dbUsers.pageLock.deleteMany({ where: { updatedAt: { lt: cutoff } } }).catch(() => {})
    const rows = await dbUsers.pageLock.findMany()
    return rows.map(mapLock)
  } catch (err) {
    console.warn('[presence] lock list failed:', err)
    return []
  }
}

export interface UsrinfoStats {
  ok: boolean
  status: 'online' | 'offline' | 'not_configured'
  latencyMs: number
  /** Real row counts measured with COUNT(*) — no estimates. */
  identities: number
  presenceRows: number
  liveLocks: number
  /** Real stored-content bytes via LENGTH() sums (bytes in MySQL). */
  contentBytes: number
  bytesMeasured: boolean
}

/**
 * Users-cluster quota: operator override first, otherwise the TiDB
 * Serverless (Starter) row-storage allowance (5 GiB, per PingCAP docs).
 * Documented plan value, NOT a measurement — set USERS_QUOTA_BYTES if the
 * cluster is on a paid plan.
 */
export const USRINFO_QUOTA_BYTES_DEFAULT = 5 * 1024 * 1024 * 1024

export function getUsrinfoQuotaBytes(): number {
  const raw = Number(process.env.USERS_QUOTA_BYTES || 0)
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw)
  return USRINFO_QUOTA_BYTES_DEFAULT
}

/**
 * REAL users telemetry for the storage dashboard: liveness + measured row
 * counts + measured content bytes. The quota ceiling is the documented TiDB
 * Starter allowance (labeled with its source) unless overridden.
 */
export async function getUsrinfoStats(): Promise<UsrinfoStats> {
  const zero = { identities: 0, presenceRows: 0, liveLocks: 0, contentBytes: 0 }
  if (!isUsrinfoConfigured()) {
    return { ok: false, status: 'not_configured', latencyMs: 0, ...zero, bytesMeasured: false }
  }
  const start = Date.now()
  const ROW = 128
  try {
    const presenceCutoff = new Date(Date.now() - PRESENCE_TTL_MS)
    const lockCutoff = new Date(Date.now() - LEASE_TTL_MS)
    // Prune TTL-corpses BEFORE counting so /api/storage never reports
    // stale presence rows / dead leases (same pruning listPresence does).
    await dbUsers.presence.deleteMany({ where: { updatedAt: { lt: presenceCutoff } } }).catch(() => {})
    await dbUsers.pageLock.deleteMany({ where: { updatedAt: { lt: lockCutoff } } }).catch(() => {})
    const [identities, presenceRows, liveLocks, iBytes, pBytes, lBytes] = await Promise.all([
      dbUsers.identity.count(),
      dbUsers.presence.count(),
      dbUsers.pageLock.count(),
      dbUsers.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(LENGTH(name) + LENGTH(pinHash) + LENGTH(salt) + LENGTH(color)), 0) AS b,
               COUNT(*) AS n FROM identities`,
      dbUsers.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(LENGTH(clientId) + LENGTH(tabId) + LENGTH(name) + LENGTH(color) + LENGTH(COALESCE(pageId, '')) + LENGTH(activity)), 0) AS b,
               COUNT(*) AS n FROM presence`,
      dbUsers.$queryRaw<Array<{ b: bigint | number | null; n: bigint | number | null }>>`
        SELECT COALESCE(SUM(LENGTH(pageId) + LENGTH(clientId) + LENGTH(name) + LENGTH(color)), 0) AS b,
               COUNT(*) AS n FROM page_locks`,
    ])
    const sized = (r: { b: bigint | number | null; n: bigint | number | null } | undefined) =>
      Number(r?.b ?? 0) + Number(r?.n ?? 0) * ROW
    return {
      ok: true,
      status: 'online',
      latencyMs: Date.now() - start,
      identities,
      presenceRows,
      liveLocks,
      contentBytes: sized(iBytes?.[0]) + sized(pBytes?.[0]) + sized(lBytes?.[0]),
      bytesMeasured: true,
    }
  } catch (err) {
    console.warn('[usrinfo] stats probe failed:', (err as any)?.message || err)
    return { ok: false, status: 'offline', latencyMs: Date.now() - start, ...zero, bytesMeasured: false }
  }
}
