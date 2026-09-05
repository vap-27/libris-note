'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Database,
  HardDrive,
  Server,
  ShieldCheck,
  RefreshCw,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  CloudUpload,
  Activity,
  Layers,
  Cpu,
  BookOpen,
  ArrowRight,
  Sparkles,
  Radio,
  Clock,
  RotateCcw,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'

interface StorageData {
  timestamp: string
  queryDurationMs: number
  overall: {
    status: 'healthy' | 'failover_active' | 'degraded'
    failoverMode: 'standby' | 'active'
    redundancyLevel: string
    totalQuotaBytes: number
    totalQuotaFormatted: string
    quotaNote?: string
    totalUsedBytes: number
    totalUsedFormatted: string
    totalAvailableBytes: number
    totalAvailableFormatted: string
    percentUsed: number
  }
  tidb: {
    booksCluster: {
      label: string
      status: 'online' | 'offline'
      endpoint: string
      latencyMs: number
      quotaBytes: number
      quotaFormatted: string
      usedBytes: number
      usedFormatted: string
      bytesMeasured?: boolean
      method?: string
      availableBytes: number
      availableFormatted: string
      percentUsed: number
      tables: {
        books: number
        pages: number
        pagesLive?: number
        pagesTombstoned?: number
      }
    }
    notesCluster: {
      label: string
      status: 'online' | 'offline'
      endpoint: string
      latencyMs: number
      quotaBytes: number
      quotaFormatted: string
      quotaSource?: string
      usedBytes: number
      usedFormatted: string
      bytesMeasured?: boolean
      method?: string
      availableBytes: number
      availableFormatted: string
      percentUsed: number
      tables: {
        pageNotes: number
        pageNotesLive?: number
        pageNotesTombstoned?: number
        boardNotes: number
        boardNotesLive?: number
        boardNotesTombstoned?: number
      }
    }
  }
  turso: {
    label: string
    status: 'online' | 'offline'
    endpoint?: string
    latencyMs: number
    quotaBytes: number
    quotaFormatted: string
    quotaSource: 'env-override' | 'cockroachdb-cloud-free-tier-default'
    usedBytes: number
    usedFormatted: string
    bytesMeasured: boolean
    availableBytes: number
    availableFormatted: string
    percentUsed: number
    lastBackupAt: string | null
    syncMode?: string
    tables: {
      books: number
      pages: number
      pagesLive?: number
      pagesTombstoned?: number
      pageNotes: number
      pageNotesLive?: number
      pageNotesTombstoned?: number
      boardNotes: number
      boardNotesLive?: number
      boardNotesTombstoned?: number
    }
  }
  usrinfo: {
    label: string
    status: 'online' | 'offline' | 'not_configured'
    latencyMs: number
    quotaBytes: number
    quotaFormatted: string
    quotaSource: 'env-override' | 'tidb-starter-5gib-row-default'
    usedBytes: number
    usedFormatted: string
    bytesMeasured: boolean
    availableBytes: number
    availableFormatted: string
    percentUsed: number
    tables: {
      identities: number
      presence: number
      pageLocks: number
    }
  }
}

/** Status pill tone: green = online, red = offline/unreachable, amber = not configured. */
function statusTone(status: string | undefined): { pill: string; dot: string; label: string } {
  if (status === 'online') {
    return {
      pill: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20',
      dot: 'bg-emerald-400',
      label: 'online',
    }
  }
  if (status === 'not_configured') {
    return {
      pill: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
      dot: 'bg-amber-400',
      label: 'not configured',
    }
  }
  return {
    pill: 'bg-red-500/10 text-red-300 border-red-500/20',
    dot: 'bg-red-400',
    label: status || 'offline',
  }
}

export default function StoragePage() {  const [data, setData] = useState<StorageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [backupLoading, setBackupLoading] = useState(false)
  const [restoreLoading, setRestoreLoading] = useState(false)
  const { toast } = useToast()

  const fetchTelemetry = useCallback(async () => {
    try {
      const res = await fetch('/api/storage', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setData(json)
    } catch (err: any) {
      toast({
        title: 'Telemetry Fetch Failed',
        description: err?.message || 'Could not retrieve database telemetry.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [toast])

  // Initial load once on mount — fetches inline so setState only runs in
  // the async continuation (subscription callback), not synchronously.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/storage', { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setData(json)
      } catch (err: any) {
        if (cancelled) return
        toast({
          title: 'Telemetry Fetch Failed',
          description: err?.message || 'Could not retrieve database telemetry.',
          variant: 'destructive',
        })
      } finally {
        if (!cancelled) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [toast])

  const handleRefresh = () => {
    setRefreshing(true)
    fetchTelemetry()
  }

  const triggerBackup = async () => {
    setBackupLoading(true)
    try {
      const res = await fetch('/api/backup', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Backup failed')
      }
      toast({
        title: 'Snapshot Synchronized to CockroachDB',
        description: `Backed up ${json.stats.books} books, ${json.stats.pages} pages, ${json.stats.pageNotes} margin notes, and ${json.stats.boardNotes} board notes.`,
      })
      await fetchTelemetry()
    } catch (err: any) {
      toast({
        title: 'Backup Failed',
        description: err?.message || 'Could not commit snapshot to CockroachDB.',
        variant: 'destructive',
      })
    } finally {
      setBackupLoading(false)
    }
  }

  const triggerRestore = async () => {
    const ok = window.confirm(
      'Are you sure you want to restore all data from CockroachDB backup into TiDB clusters? Existing records will be synced with backup.'
    )
    if (!ok) return

    setRestoreLoading(true)
    try {
      const res = await fetch('/api/backup?action=restore&confirm=RESTORE', { method: 'POST' })
      const json = await res.json()
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Restore failed')
      }
      const skipped = typeof json.skippedAsStale === 'number' && json.skippedAsStale > 0
        ? ` (${json.skippedAsStale} newer rows kept)`
        : ''
      toast({
        title: 'TiDB Restored from CockroachDB Backup',
        description: `Restored ${json.restored.books} books, ${json.restored.pages} pages, ${json.restored.pageNotes} margin notes, ${json.restored.boardNotes} board notes${skipped}.`,
      })
      await fetchTelemetry()
    } catch (err: any) {
      toast({
        title: 'Restore Failed',
        description: err?.message || 'Could not restore from CockroachDB.',
        variant: 'destructive',
      })
    } finally {
      setRestoreLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#07090c] text-[#e8e4dc] selection:bg-[#d9a93f]/30 font-sans">
      {/* Background ambient lighting */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[900px] h-[500px] bg-gradient-to-b from-[#d9a93f]/10 via-[#7a5c1e]/5 to-transparent blur-3xl opacity-60" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-emerald-500/5 blur-3xl opacity-50" />
      </div>

      {/* Top Navbar */}
      <header className="relative z-10 border-b border-[#2a2419]/60 backdrop-blur-md bg-[#090c10]/80">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-[#d9a93f] hover:text-[#f3d38c] transition-colors py-1 px-3 rounded-full border border-[#d9a93f]/30 bg-[#16120c]/60"
            >
              <ArrowLeft size={13} strokeWidth={2.2} />
              Return to Book
            </Link>
            <span className="text-[#5a5243] font-light">/</span>
            <div className="flex items-center gap-2">
              <Database size={16} className="text-[#d9a93f]" />
              <span className="text-sm font-semibold tracking-wide text-[#f5f1e8]">
                Cloud Storage & Failover Infrastructure
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/health"
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-medium transition-all"
            >
              <Activity size={13} />
              System Health
            </Link>

            <div className="hidden sm:flex items-center gap-2 px-3 py-1 rounded-full bg-[#12161a] border border-[#232d36] text-[11px] text-[#9eb1be]">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>TiDB + CockroachDB Redundancy Active</span>
            </div>

            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-2 text-xs font-medium text-[#d9a93f] hover:text-[#f8deb0] bg-[#1a1710] hover:bg-[#252015] border border-[#d9a93f]/40 px-3 py-1.5 rounded-lg transition-all shadow-sm disabled:opacity-50"
            >
              <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Hero Banner */}
        <section className="relative overflow-hidden rounded-2xl border border-[#3b3220]/70 bg-gradient-to-br from-[#18140c] via-[#100e0a] to-[#0a0c0e] p-6 sm:p-8 shadow-2xl">
          <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
            <HardDrive size={220} strokeWidth={1} />
          </div>

          <div className="relative z-10 max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#d9a93f]/15 border border-[#d9a93f]/30 text-xs font-medium text-[#e4be68]">
              <ShieldCheck size={14} />
              <span>High Availability Tier · Dual-Write Active</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-serif tracking-tight text-[#fdfaf5]">
              Storage Quotas & Failover Telemetry
            </h1>
            <p className="text-sm sm:text-base text-[#a69d8d] leading-relaxed">
              If TiDB Serverless runs out of storage, hits quotas, or encounters downtime, your book
              automatically fails over to the CockroachDB backup. Writes continuously replicate across both
              systems for zero data loss.
            </p>
          </div>
        </section>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-3 text-[#a89b83]">
            <RefreshCw size={28} className="animate-spin text-[#d9a93f]" />
            <p className="text-sm font-mono tracking-wide">Querying TiDB clusters & CockroachDB telemetry...</p>
          </div>
        ) : data ? (
          <>
            {/* Top 5 KPI Metrics Cards */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
              {/* Total Storage Card */}
              <div className="rounded-xl border border-[#2f2719] bg-[#120f0a]/90 p-5 space-y-3 shadow-lg hover:border-[#d9a93f]/40 transition-colors">
                <div className="flex items-center justify-between text-xs text-[#9d9280]">
                  <span className="font-mono uppercase tracking-wider">Total Allocation</span>
                  <HardDrive size={15} className="text-[#d9a93f]" />
                </div>
                <div>
                  <div className="text-2xl font-bold font-serif text-[#faf6ed]">
                    {data.overall.totalQuotaFormatted}
                  </div>
                  <div className="text-xs text-[#a09582] mt-0.5">
                    {data.overall.totalUsedFormatted} used · {data.overall.totalAvailableFormatted} free
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="h-1.5 w-full bg-[#201b12] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#d9a93f] to-emerald-400 rounded-full transition-all duration-700"
                      style={{ width: `${Math.max(1, Math.min(100, data.overall.percentUsed * 10))}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-[#786e5e] font-mono">
                    <span>{data.overall.percentUsed}% utilized</span>
                    <span title={data.overall.quotaNote ?? ''}>TiDB ×3 + CockroachDB</span>
                  </div>
                </div>
              </div>

              {/* TiDB Books Cluster A */}
              <div className="rounded-xl border border-[#242e38] bg-[#0c1217]/90 p-5 space-y-3 shadow-lg hover:border-sky-500/40 transition-colors">
                <div className="flex items-center justify-between text-xs text-[#8ca3b5]">
                  <span className="font-mono uppercase tracking-wider">TiDB Books (A)</span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusTone(data.tidb.booksCluster.status).pill}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusTone(data.tidb.booksCluster.status).dot}`} />
                    {statusTone(data.tidb.booksCluster.status).label}
                  </span>
                </div>
                <div>
                  <div className="text-2xl font-bold font-serif text-[#f2f7fb]">
                    {data.tidb.booksCluster.quotaFormatted}
                  </div>
                  <div className="text-xs text-[#7e99ac] mt-0.5">
                    {data.tidb.booksCluster.tables.books} books · {data.tidb.booksCluster.tables.pages} pages
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="h-1.5 w-full bg-[#17222c] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-sky-400 rounded-full"
                      style={{ width: `${Math.max(1, data.tidb.booksCluster.percentUsed * 10)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-[#5e778a] font-mono">
                    <span>Latency: {data.tidb.booksCluster.latencyMs}ms</span>
                    <span title="LENGTH()+allowance estimate — TiDB Serverless exposes no billed-size probe">
                      {data.tidb.booksCluster.usedFormatted} (est.)
                    </span>
                  </div>
                </div>
              </div>

              {/* TiDB Notes Cluster B */}
              <div className="rounded-xl border border-[#332a24] bg-[#140f0c]/90 p-5 space-y-3 shadow-lg hover:border-amber-500/40 transition-colors">
                <div className="flex items-center justify-between text-xs text-[#a89588]">
                  <span className="font-mono uppercase tracking-wider">TiDB Notes (B)</span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusTone(data.tidb.notesCluster.status).pill}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusTone(data.tidb.notesCluster.status).dot}`} />
                    {statusTone(data.tidb.notesCluster.status).label}
                  </span>
                </div>
                <div>
                  <div className="text-2xl font-bold font-serif text-[#fbf5f2]">
                    {data.tidb.notesCluster.quotaFormatted}
                  </div>
                  <div className="text-xs text-[#a08b7e] mt-0.5">
                    {data.tidb.notesCluster.tables.pageNotes} margin notes · {data.tidb.notesCluster.tables.boardNotes} board notes
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="h-1.5 w-full bg-[#241a14] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-400 rounded-full"
                      style={{ width: `${Math.max(1, data.tidb.notesCluster.percentUsed * 10)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-[#7a6456] font-mono">
                    <span>Latency: {data.tidb.notesCluster.latencyMs}ms</span>
                    <span title="LENGTH()+allowance estimate — TiDB Serverless exposes no billed-size probe">
                      {data.tidb.notesCluster.usedFormatted} (est.)
                    </span>
                  </div>
                </div>
              </div>

              {/* CockroachDB Backup Engine — real measured bytes, honest ceiling */}
              <div className="rounded-xl border border-[#21352b] bg-[#0c1712]/90 p-5 space-y-3 shadow-lg hover:border-emerald-500/40 transition-colors">
                <div className="flex items-center justify-between text-xs text-[#8cbca3]">
                  <span className="font-mono uppercase tracking-wider">CockroachDB Failover</span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusTone(data.turso.status).pill}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusTone(data.turso.status).dot}`} />
                    {statusTone(data.turso.status).label}
                  </span>
                </div>
                <div>
                  <div className="text-2xl font-bold font-serif text-[#f0fbf5]">
                    {data.turso.bytesMeasured ? data.turso.usedFormatted : 'unmeasured'}
                  </div>
                  <div
                    className="text-xs text-[#7eaf96] mt-0.5"
                    title="CockroachDB Basic free = org-level $15 credit (50M RUs + 10 GiB/mo shared across all clusters). See Cloud Console for real usage."
                  >
                    Content bytes (measured) · quota {data.turso.quotaFormatted} (
                    {data.turso.quotaSource === 'env-override' ? 'operator override' : 'Basic 10 GiB free'})
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="h-1.5 w-full bg-[#14281f] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-400 rounded-full"
                      style={{ width: `${data.turso.bytesMeasured ? Math.max(1, data.turso.percentUsed * 10) : 1}%` }}
                    />
                  </div>
                  <div className="flex justify-between gap-2 text-[10px] text-[#55866f] font-mono">
                    <span className="truncate">Backup cluster · {data.turso.latencyMs}ms</span>
                    <span className="flex-shrink-0">
                      {data.turso.bytesMeasured ? `${data.turso.availableFormatted} free` : 'probe failed'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Users store — measured bytes + documented TiDB Starter ceiling */}
              <div className="rounded-xl border border-[#2b3a4a] bg-[#0c1219]/90 p-5 space-y-3 shadow-lg hover:border-sky-500/40 transition-colors">
                <div className="flex items-center justify-between text-xs text-[#8fb4cc]">
                  <span className="font-mono uppercase tracking-wider">Users · TiDB</span>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${statusTone(data.usrinfo?.status).pill}`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${statusTone(data.usrinfo?.status).dot}`} />
                    {statusTone(data.usrinfo?.status).label}
                  </span>
                </div>
                <div>
                  <div className="text-2xl font-bold font-serif text-[#eef6fc]">
                    {data.usrinfo?.bytesMeasured ? data.usrinfo.usedFormatted : 'unmeasured'}
                  </div>
                  <div
                    className="text-xs text-[#7e9cb3] mt-0.5"
                    title="TiDB Starter = 5 GiB row storage per cluster."
                  >
                    Content bytes (measured) · quota {data.usrinfo?.quotaFormatted} (
                    {data.usrinfo?.quotaSource === 'env-override' ? 'operator override' : 'Starter 5 GiB'})
                  </div>
                  <div className="text-xs text-[#7e9cb3] mt-0.5">
                    {data.usrinfo?.tables.identities ?? 0} names · {data.usrinfo?.tables.presence ?? 0}{' '}
                    presence · {data.usrinfo?.tables.pageLocks ?? 0} leases
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="h-1.5 w-full bg-[#14283a] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-sky-400 rounded-full"
                      style={{
                        width: `${data.usrinfo?.bytesMeasured ? Math.max(1, (data.usrinfo?.percentUsed ?? 0) * 10) : 1}%`,
                      }}
                    />
                  </div>
                  <div className="flex justify-between gap-2 text-[10px] text-[#5b7a90] font-mono">
                    <span className="truncate">Identity store · {data.usrinfo?.latencyMs ?? 0}ms</span>
                    <span className="flex-shrink-0">
                      {data.usrinfo?.bytesMeasured ? `${data.usrinfo?.availableFormatted} free` : 'probe failed'}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            {/* Architecture & High-Availability Flow Card */}
            <section className="rounded-xl border border-[#2c2518] bg-[#0e0c08]/80 p-6 space-y-5 shadow-xl">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#262015] pb-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-[#d9a93f]/10 border border-[#d9a93f]/30 text-[#d9a93f]">
                    <Layers size={18} />
                  </div>
                  <div>
                    <h2 className="text-lg font-serif font-semibold text-[#f7f2e7]">
                      Real-Time Redundancy & Failover Topology
                    </h2>
                    <p className="text-xs text-[#9a8e7a]">
                      How requests are routed, synchronized, and safeguarded against storage exhaustion
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-emerald-950/60 border border-emerald-500/30 text-emerald-300">
                    <CheckCircle2 size={13} className="text-emerald-400" />
                    Failover Active & Tested
                  </span>
                </div>
              </div>

              {/* Visual Flow diagram */}
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 pt-2">
                <div className="rounded-lg border border-[#2f2719] bg-[#16120c] p-4 space-y-2">
                  <div className="flex items-center gap-2 text-[#d9a93f] text-xs font-mono">
                    <Cpu size={14} />
                    <span>LAYER 1: Next.js Vercel Edge</span>
                  </div>
                  <p className="text-xs text-[#b0a490] leading-relaxed">
                    Executes resilient query wrapper <code className="text-[#f0d17c]">withTiDBFallback</code>. Every write is asynchronously replicated to CockroachDB.
                  </p>
                </div>

                <div className="rounded-lg border border-[#242e38] bg-[#0f151c] p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 text-xs font-mono">
                    <Server size={14} />
                    <span>LAYER 2: TiDB Primary Cloud</span>
                  </div>
                  <p className="text-xs text-[#8da0af] leading-relaxed">
                    Cluster A holds books & pages (5GB quota). Cluster B holds notes & board (5GB quota). Primary engine for reads/writes.
                  </p>
                </div>

                <div className="rounded-lg border border-[#1f3529] bg-[#0c1812] p-4 space-y-2">
                  <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono">
                    <ShieldCheck size={14} />
                    <span>LAYER 3: CockroachDB Failover Engine</span>
                  </div>
                  <p className="text-xs text-[#82b098] leading-relaxed">
                    Dedicated backup engine. If TiDB hits storage limits or goes down, requests immediately and transparently route here.
                  </p>
                </div>

                <div className="rounded-lg border border-[#26364a] bg-[#0c1219] p-4 space-y-2">
                  <div className="flex items-center gap-2 text-sky-400 text-xs font-mono">
                    <Radio size={14} />
                    <span>LAYER 4: Users Identity Store</span>
                  </div>
                  <p className="text-xs text-[#8ba7bd] leading-relaxed">
                    Third TiDB cluster holding claimed names, presence heartbeats, and page edit leases. Never book content.
                  </p>
                </div>
              </div>
            </section>

            {/* Table Inventory Grid */}
            <section className="rounded-xl border border-[#2a2418] bg-[#0c0a07] overflow-hidden shadow-xl">
              <div className="p-5 border-b border-[#211b10] flex items-center justify-between">
                <div>
                  <h3 className="text-base font-serif font-semibold text-[#f5f0e4]">
                    Database Table Inventory & Synchronization
                  </h3>
                  <p className="text-xs text-[#958874] mt-0.5">
                    Live row counts and engine mapping across primary and backup databases
                  </p>
                </div>

                <span className="text-xs font-mono text-[#d9a93f]">
                  Telemetry latency: {data.queryDurationMs}ms
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-sans">
                  <thead className="bg-[#14100a] text-[#a09480] uppercase font-mono text-[10px] tracking-wider border-b border-[#261f14]">
                    <tr>
                      <th className="py-3 px-4">Entity</th>
                      <th className="py-3 px-4">Primary Cluster</th>
                      <th className="py-3 px-4">Primary Engine</th>
                      <th className="py-3 px-4">Backup Engine</th>
                      <th className="py-3 px-4 text-right">TiDB Records</th>
                      <th className="py-3 px-4 text-right">Backup Records</th>
                      <th className="py-3 px-4 text-center">Sync Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e1910] text-[#ded9cd]">
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <BookOpen size={14} className="text-[#d9a93f]" />
                        <span>books</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB Cluster A</td>
                      <td className="py-3 px-4 text-sky-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-emerald-400 font-mono">CockroachDB</td>
                      <td className="py-3 px-4 text-right font-mono">{data.tidb.booksCluster.tables.books}</td>
                      <td className="py-3 px-4 text-right font-mono">{data.turso.tables.books}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                          <CheckCircle2 size={12} /> Synced
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Layers size={14} className="text-[#d9a93f]" />
                        <span>pages</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB Cluster A</td>
                      <td className="py-3 px-4 text-sky-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-emerald-400 font-mono">CockroachDB</td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.tidb.booksCluster.tables.pages}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.tidb.booksCluster.tables.pagesLive ?? data.tidb.booksCluster.tables.pages} live
                          {typeof data.tidb.booksCluster.tables.pagesTombstoned === 'number' &&
                          data.tidb.booksCluster.tables.pagesTombstoned > 0
                            ? ` · ${data.tidb.booksCluster.tables.pagesTombstoned} tombstoned`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.turso.tables.pages}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.turso.tables.pagesLive ?? data.turso.tables.pages} live
                          {typeof data.turso.tables.pagesTombstoned === 'number' &&
                          data.turso.tables.pagesTombstoned > 0
                            ? ` · ${data.turso.tables.pagesTombstoned} tombstoned`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                          <CheckCircle2 size={12} /> Synced
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Clock size={14} className="text-[#d9a93f]" />
                        <span>page_notes</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB Cluster B</td>
                      <td className="py-3 px-4 text-amber-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-emerald-400 font-mono">CockroachDB</td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.tidb.notesCluster.tables.pageNotes}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.tidb.notesCluster.tables.pageNotesLive ?? data.tidb.notesCluster.tables.pageNotes} live
                          {typeof data.tidb.notesCluster.tables.pageNotesTombstoned === 'number' &&
                          data.tidb.notesCluster.tables.pageNotesTombstoned > 0
                            ? ` · ${data.tidb.notesCluster.tables.pageNotesTombstoned} in trash`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.turso.tables.pageNotes}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.turso.tables.pageNotesLive ?? data.turso.tables.pageNotes} live
                          {typeof data.turso.tables.pageNotesTombstoned === 'number' &&
                          data.turso.tables.pageNotesTombstoned > 0
                            ? ` · ${data.turso.tables.pageNotesTombstoned} in trash`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                          <CheckCircle2 size={12} /> Synced
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Sparkles size={14} className="text-[#d9a93f]" />
                        <span>board_notes</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB Cluster B</td>
                      <td className="py-3 px-4 text-amber-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-emerald-400 font-mono">CockroachDB</td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.tidb.notesCluster.tables.boardNotes}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.tidb.notesCluster.tables.boardNotesLive ?? data.tidb.notesCluster.tables.boardNotes} live
                          {typeof data.tidb.notesCluster.tables.boardNotesTombstoned === 'number' &&
                          data.tidb.notesCluster.tables.boardNotesTombstoned > 0
                            ? ` · ${data.tidb.notesCluster.tables.boardNotesTombstoned} in trash`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono">
                        {data.turso.tables.boardNotes}
                        <span className="block text-[10px] text-[#7d7261]">
                          {data.turso.tables.boardNotesLive ?? data.turso.tables.boardNotes} live
                          {typeof data.turso.tables.boardNotesTombstoned === 'number' &&
                          data.turso.tables.boardNotesTombstoned > 0
                            ? ` · ${data.turso.tables.boardNotesTombstoned} in trash`
                            : ''}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                          <CheckCircle2 size={12} /> Synced
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Radio size={14} className="text-sky-400" />
                        <span>identities</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB users_db</td>
                      <td className="py-3 px-4 text-sky-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-[#6b6257] font-mono">— (identity only)</td>
                      <td className="py-3 px-4 text-right font-mono">—</td>
                      <td className="py-3 px-4 text-right font-mono">{data.usrinfo?.tables.identities ?? 0}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
                          <CheckCircle2 size={12} /> {data.usrinfo?.status ?? 'unknown'}
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Radio size={14} className="text-sky-400" />
                        <span>presence</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB users_db</td>
                      <td className="py-3 px-4 text-sky-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-[#6b6257] font-mono">— (ephemeral)</td>
                      <td className="py-3 px-4 text-right font-mono">—</td>
                      <td className="py-3 px-4 text-right font-mono">{data.usrinfo?.tables.presence ?? 0}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
                          <CheckCircle2 size={12} /> {data.usrinfo?.latencyMs ?? 0}ms
                        </span>
                      </td>
                    </tr>
                    <tr className="hover:bg-[#15120c]/60 transition-colors">
                      <td className="py-3 px-4 font-medium flex items-center gap-2">
                        <Radio size={14} className="text-sky-400" />
                        <span>page_locks</span>
                      </td>
                      <td className="py-3 px-4 text-[#9c8f7d]">TiDB users_db</td>
                      <td className="py-3 px-4 text-sky-400 font-mono">MySQL 8 / TiDB</td>
                      <td className="py-3 px-4 text-[#6b6257] font-mono">— (leases)</td>
                      <td className="py-3 px-4 text-right font-mono">—</td>
                      <td className="py-3 px-4 text-right font-mono">{data.usrinfo?.tables.pageLocks ?? 0}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
                          <CheckCircle2 size={12} /> live
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {/* Backup & Operational Control Center */}
            <section className="rounded-xl border border-[#3b3220] bg-gradient-to-r from-[#14100a] via-[#16130d] to-[#121815] p-6 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-5">
              <div className="space-y-1 max-w-xl">
                <div className="flex items-center gap-2 text-xs font-mono text-[#d9a93f]">
                  <CloudUpload size={14} />
                  <span>MANUAL SNAPSHOT & RESTORE CONTROLS</span>
                </div>
                <h3 className="text-lg font-serif font-semibold text-[#fbf8f2]">
                  On-Demand Redundancy Sync
                </h3>
                <p className="text-xs text-[#a09482] leading-relaxed">
                  While continuous dual-write sync is automatically running in the background, you can trigger a full snapshot backup to CockroachDB or restore data back into TiDB at any moment.
                </p>
                {data.turso.lastBackupAt && (
                  <p className="text-[11px] text-[#7d7261] font-mono pt-1">
                    Last snapshot backup: {new Date(data.turso.lastBackupAt).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={triggerBackup}
                  disabled={backupLoading}
                  className="inline-flex items-center gap-2 text-xs font-semibold px-4 py-2.5 rounded-lg bg-[#d9a93f] hover:bg-[#ebbb52] text-[#1a140a] transition-all shadow-md disabled:opacity-50 cursor-pointer"
                >
                  <CloudUpload size={15} className={backupLoading ? 'animate-bounce' : ''} />
                  <span>{backupLoading ? 'Syncing Snapshot...' : 'Backup Snapshot to CockroachDB'}</span>
                </button>

                <button
                  onClick={triggerRestore}
                  disabled={restoreLoading}
                  className="inline-flex items-center gap-2 text-xs font-medium px-4 py-2.5 rounded-lg bg-[#1c1810] hover:bg-[#282216] text-[#ded7cb] border border-[#d9a93f]/30 transition-all shadow-sm disabled:opacity-50 cursor-pointer"
                >
                  <RotateCcw size={14} className={restoreLoading ? 'animate-spin' : ''} />
                  <span>{restoreLoading ? 'Restoring...' : 'Restore to TiDB'}</span>
                </button>
              </div>
            </section>
          </>
        ) : (
          <div className="text-center py-20 text-[#a09480]">
            <AlertCircle size={32} className="mx-auto text-amber-500 mb-2" />
            <p>Unable to retrieve storage telemetry.</p>
          </div>
        )}
      </main>
    </div>
  )
}
