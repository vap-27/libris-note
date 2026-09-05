'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import Link from 'next/link'
import {
  Activity,
  Server,
  Database,
  ShieldCheck,
  Zap,
  RefreshCw,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  HardDrive,
  Cpu,
  Layers,
  Sparkles,
  Radio,
  ArrowRight,
  Clock,
  Terminal,
  BookOpen,
  PlusCircle,
  Edit3,
  Trash2,
  RotateCcw,
  Filter,
  Users,
} from 'lucide-react'

interface ActivityLog {
  id: string
  timestamp: string
  timeFormatted: string
  action: 'create' | 'edit' | 'delete' | 'restore' | 'shift' | 'diagnostic' | 'backup' | 'sync'
  title: string
  details: string
  engine: 'TiDB Books' | 'TiDB Notes' | 'CockroachDB' | 'Turso LibSQL' | 'System'
  level: 'info' | 'success' | 'warn' | 'error'
}

interface HealthResponse {
  status: string
  mode: string
  operational: boolean
  architecture: {
    primaryEngine: string
    overflowEngine: string
    shiftThreshold: string
    policy: string
  }
  shiftEngine: {
    thresholdBytes: number
    thresholdFormatted: string
    criticalThresholdBytes?: number
    criticalThresholdFormatted?: string
    isCritical1MB?: boolean
    criticalAlertMessage?: string | null
    books: {
      remainingBytes: number
      isUnder10MB: boolean
      isUnder1MB?: boolean
      shiftedToTurso: boolean
      targetEngine: string
      quotaBytes?: number
    }
    notes: {
      remainingBytes: number
      isUnder10MB: boolean
      isUnder1MB?: boolean
      shiftedToTurso: boolean
      targetEngine: string
      quotaBytes?: number
    }
    manualOverride: boolean
  }
  primary: {
    books: {
      ok: boolean
      status: string
      cluster: string
      latencyMs: number
      error?: string
    }
    notes: {
      ok: boolean
      status: string
      cluster: string
      latencyMs: number
      error?: string
    }
  }
  overflow: {
    turso: {
      ok: boolean
      status: string
      configured: boolean
      latencyMs: number
      error?: string
    }
    quotaFormatted: string
    thresholdBytes: number
    quotaBytes?: number
    quotaSource?: string
  }
  activityLogs: ActivityLog[]
  checkedAt: string
}

/** Quota bytes → "5.00 GiB". Falls back to '—' when the API omits it. */
function formatQuota(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '—'
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`
}

export default function HealthPage() {  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [clearingLogs, setClearingLogs] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<string>('')
  const [autoRefreshInterval, setAutoRefreshInterval] = useState<number>(0) // 0 = Manual (default)
  const [activeTab, setActiveTab] = useState<string>('all')
  const [liveUsers, setLiveUsers] = useState<
    Array<{ clientId: string; name: string; color: string; pageId: string | null; activity: string }>
  >([])
  // Real infra totals ride along from /api/storage (never hardcoded — the
  // backup quota is operator-overridable, so a literal would lie).
  const [quotaTotal, setQuotaTotal] = useState<string | null>(null)

  const fetchHealth = useCallback(async (isManual = false) => {
    try {
      if (isManual) setLoading(true)
      const url = isManual ? '/api/health?manual=1' : '/api/health'
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok && res.status !== 503) {
        throw new Error(`Health probe HTTP ${res.status}`)
      }
      const data: HealthResponse = await res.json()
      setHealth(data)
      setError(null)
      setLastRefreshed(new Date().toLocaleTimeString())
      // Live readers ride along (best-effort; never fails the health probe).
      try {
        const pr = await fetch('/api/presence', { headers: { Accept: 'application/json' } })
        if (pr.ok) {
          const pd = await pr.json()
          if (Array.isArray(pd.users)) setLiveUsers(pd.users)
        }
      } catch {}
      // Real quota total (best-effort; never fails the health probe).
      try {
        const sr = await fetch('/api/storage', { headers: { Accept: 'application/json' } })
        if (sr.ok) {
          const sd = await sr.json()
          if (typeof sd?.overall?.totalQuotaFormatted === 'string') {
            setQuotaTotal(sd.overall.totalQuotaFormatted)
          }
        }
      } catch {}
    } catch (err: any) {
      setError(err.message || 'Failed to ping health endpoint')
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load once on mount — fetches inline so setState only runs in
  // the async continuation (subscription callback), not synchronously.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/health', {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok && res.status !== 503) {
          throw new Error(`Health probe HTTP ${res.status}`)
        }
        const data: HealthResponse = await res.json()
        if (cancelled) return
        setHealth(data)
        setError(null)
        setLastRefreshed(new Date().toLocaleTimeString())
        try {
          const pr = await fetch('/api/presence', { headers: { Accept: 'application/json' } })
          if (pr.ok && !cancelled) {
            const pd = await pr.json()
            if (Array.isArray(pd.users)) setLiveUsers(pd.users)
          }
        } catch {}
        try {
          const sr = await fetch('/api/storage', { headers: { Accept: 'application/json' } })
          if (sr.ok && !cancelled) {
            const sd = await sr.json()
            if (typeof sd?.overall?.totalQuotaFormatted === 'string') {
              setQuotaTotal(sd.overall.totalQuotaFormatted)
            }
          }
        } catch {}
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Failed to ping health endpoint')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  // Optional controlled auto-refresh interval (0 = Manual only, 60 = 1m, 600 = 10m)
  useEffect(() => {
    if (autoRefreshInterval <= 0) return
    const id = setInterval(() => {
      fetchHealth(false)
    }, autoRefreshInterval * 1000)
    return () => clearInterval(id)
  }, [autoRefreshInterval, fetchHealth])

  const handleClearLogs = async () => {
    setClearingLogs(true)
    try {
      await fetch('/api/health', { method: 'DELETE' })
      await fetchHealth(false)
    } catch (err: any) {
      setError(`Failed to clear logs: ${err.message}`)
    } finally {
      setClearingLogs(false)
    }
  }

  const isShiftActive =
    health?.shiftEngine.books.shiftedToTurso || health?.shiftEngine.notes.shiftedToTurso

  const filteredLogs = (health?.activityLogs || []).filter((log) => {
    if (activeTab === 'all') return true
    if (activeTab === 'create') return log.action === 'create'
    if (activeTab === 'edit') return log.action === 'edit'
    if (activeTab === 'delete') return log.action === 'delete'
    if (activeTab === 'restore') return log.action === 'restore'
    if (activeTab === 'sync') return log.action === 'sync'
    if (activeTab === 'shift') return log.action === 'shift'
    if (activeTab === 'diagnostic') return log.action === 'diagnostic'
    return true
  })

  const getActionBadge = (action: ActivityLog['action']) => {
    switch (action) {
      case 'create':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
            <PlusCircle className="w-2.5 h-2.5" /> Created
          </span>
        )
      case 'edit':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/20 text-blue-300 border border-blue-500/30">
            <Edit3 className="w-2.5 h-2.5" /> Edited
          </span>
        )
      case 'delete':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/30">
            <Trash2 className="w-2.5 h-2.5" /> Removed
          </span>
        )
      case 'restore':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-500/30">
            <RotateCcw className="w-2.5 h-2.5" /> Restored
          </span>
        )
      case 'sync':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-teal-500/20 text-teal-300 border border-teal-500/30">
            <Radio className="w-2.5 h-2.5" /> Synced
          </span>
        )
      case 'shift':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-purple-500/20 text-purple-300 border border-purple-500/30">
            <Zap className="w-2.5 h-2.5" /> Storage Shift
          </span>
        )
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-white/10 text-white border border-white/20">
            <Activity className="w-2.5 h-2.5" /> Diagnostics
          </span>
        )
    }
  }

  return (
    <div className="min-h-screen bg-[#07090c] text-[#e8e4dc] font-sans selection:bg-[#f0d17c]/20 selection:text-[#f0d17c]">
      {/* Background Ambience */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div className="absolute -top-40 -right-40 w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[140px]" />
        <div className="absolute top-1/2 -left-40 w-[600px] h-[600px] bg-[#f0d17c]/5 rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 right-1/4 w-[600px] h-[600px] bg-blue-500/5 rounded-full blur-[140px]" />
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
        {/* Navigation & Breadcrumbs */}
        <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-8 border-b border-white/10 mb-8">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-[#a89f91] mb-1">
              <Link href="/" className="hover:text-[#f0d17c] transition-colors">
                Libris
              </Link>
              <span>/</span>
              <span className="text-[#f0d17c]">Health & Diagnostics</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-serif text-[#f4efe6] tracking-tight flex items-center gap-3">
              <Activity className="w-7 h-7 text-emerald-400" />
              Database Health & Dynamic Shift Monitor
            </h1>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[#e8e4dc] border border-white/10 transition-all hover:border-[#f0d17c]/30"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Return to Book
            </Link>

            <Link
              href="/storage"
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[#e8e4dc] border border-white/10 transition-all hover:border-[#f0d17c]/30"
            >
              <HardDrive className="w-3.5 h-3.5 text-[#f0d17c]" />
              Storage Dashboard
            </Link>

            {/* Auto-Refresh Frequency Selector */}
            <div className="flex items-center gap-1.5 bg-white/[0.04] border border-white/10 px-2.5 py-1.5 rounded-xl text-xs text-[#a89f91]">
              <Clock className="w-3.5 h-3.5 text-[#f0d17c]" />
              <select
                value={autoRefreshInterval}
                onChange={(e) => setAutoRefreshInterval(Number(e.target.value))}
                className="bg-transparent text-white border-none outline-none text-xs cursor-pointer"
              >
                <option value={0} className="bg-[#0f131a] text-white">Manual Only (No Ping)</option>
                <option value={60} className="bg-[#0f131a] text-white">Auto: Every 60s</option>
                <option value={600} className="bg-[#0f131a] text-white">Auto: Every 600s (10m)</option>
              </select>
            </div>

            {/* Manual Run Diagnostics Button */}
            <button
              onClick={() => fetchHealth(true)}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-all shadow-lg shadow-emerald-500/10 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Run Diagnostics Manually
            </button>
          </div>
        </header>

        {/* Global Notice Banner */}
        {error && (
          <div className="mb-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center gap-3 text-red-300 text-sm">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <span>Notice: {error}</span>
          </div>
        )}

        {/* Critical Peak Storage Alert Banner (< 1MB) */}
        {health?.shiftEngine.isCritical1MB && (
          <div className="mb-8 p-5 rounded-2xl bg-gradient-to-r from-red-950/90 via-amber-950/80 to-red-950/90 border border-red-500/50 shadow-2xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-in fade-in duration-300">
            <div className="flex items-start sm:items-center gap-4">
              <div className="p-3 rounded-xl bg-red-500/20 text-red-400 border border-red-500/40 animate-pulse">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-red-200 font-bold text-base">
                    CRITICAL STORAGE PEAK ALERT (&lt; 1MB REMAINING)
                  </h3>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-widest bg-red-500 text-white animate-bounce">
                    Emergency Shift Active
                  </span>
                </div>
                <p className="text-xs sm:text-sm text-red-200/80 mt-1 max-w-3xl">
                  TiDB remaining storage is critically exhausted (&lt; 1MB). To safeguard against disk rejection and data loss, all incoming page edits and notes are automatically routed directly to the CockroachDB backup engine.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Hero Health Status Banner */}
        <section className="mb-8 p-6 md:p-8 rounded-2xl bg-[#0f131a]/80 backdrop-blur-xl border border-white/10 relative overflow-hidden shadow-2xl">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div className="flex items-start sm:items-center gap-5">
              <div className="relative flex-shrink-0 mt-1 sm:mt-0">
                <div
                  className={`w-16 h-16 rounded-2xl flex items-center justify-center border shadow-lg transition-all ${
                    isShiftActive
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300 shadow-amber-500/20'
                      : health?.operational
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300 shadow-emerald-500/20'
                      : 'bg-red-500/20 border-red-500/40 text-red-300 shadow-red-500/20'
                  }`}
                >
                  {isShiftActive ? (
                    <Zap className="w-8 h-8 animate-bounce" />
                  ) : health?.operational ? (
                    <ShieldCheck className="w-8 h-8" />
                  ) : (
                    <AlertTriangle className="w-8 h-8" />
                  )}
                </div>
                {health?.operational && (
                  <span className="absolute -top-1 -right-1 flex h-4 w-4">
                    <span
                      className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                        isShiftActive ? 'bg-amber-400' : 'bg-emerald-400'
                      }`}
                    />
                    <span
                      className={`relative inline-flex rounded-full h-4 w-4 border-2 border-[#07090c] ${
                        isShiftActive ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                    />
                  </span>
                )}
              </div>

              <div>
                <div className="flex items-center gap-3 flex-wrap mb-1.5">
                  <h2 className="text-xl md:text-2xl font-serif text-[#f4efe6]">
                    {isShiftActive
                      ? 'Dynamic Shift Active — Directing to CockroachDB'
                      : health?.operational
                      ? 'Dual-Engine High Availability Operational'
                      : 'System Degraded'}
                  </h2>
                  <span
                    className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                      isShiftActive
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : health?.operational
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-red-500/20 text-red-300 border border-red-500/30'
                    }`}
                  >
                    <Radio className="w-3 h-3 animate-pulse" />
                    {isShiftActive ? 'SHIFT ENGAGED' : '100% OPERATIONAL'}
                  </span>
                </div>
                <p className="text-sm text-[#a89f91] max-w-3xl leading-relaxed">
                  Continuous background ping is{' '}
                  <span className="text-emerald-400 font-semibold">
                    {autoRefreshInterval === 0 ? 'disabled' : `set to ${autoRefreshInterval}s`}
                  </span>
                  . Run diagnostics whenever you want using the manual trigger. When TiDB is under{' '}
                  <span className="text-[#f0d17c] font-semibold">10 MB</span>, all newly written notes &
                  pages directly shift to CockroachDB (backup engine).
                </p>
              </div>
            </div>

            {/* Quick Metrics */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 w-full lg:w-auto border-t lg:border-t-0 lg:border-l border-white/10 pt-4 lg:pt-0 lg:pl-6">
              <div className="bg-black/30 p-3 rounded-xl border border-white/5">
                <div className="text-[10px] uppercase tracking-wider text-[#a89f91]">Routing Target</div>
                <div className="text-sm font-semibold text-[#f0d17c] mt-0.5 truncate">
                  {isShiftActive ? 'CockroachDB Fallback' : 'TiDB Primary'}
                </div>
              </div>

              <div className="bg-black/30 p-3 rounded-xl border border-white/5">
                <div className="text-[10px] uppercase tracking-wider text-[#a89f91]">Shift Threshold</div>
                <div className="text-sm font-semibold text-emerald-300 mt-0.5">&lt; 10.00 MB</div>
              </div>

              <div className="bg-black/30 p-3 rounded-xl border border-white/5 col-span-2 sm:col-span-1">
                <div className="text-[10px] uppercase tracking-wider text-[#a89f91]">Combined Quota</div>
                <div className="text-sm font-semibold text-white mt-0.5">{quotaTotal ?? '—'}</div>
              </div>

              <div className="bg-black/30 p-3 rounded-xl border border-white/5 col-span-2 sm:col-span-1">
                <div className="text-[10px] uppercase tracking-wider text-[#a89f91] flex items-center gap-1.5">
                  <Users className="w-3 h-3" aria-hidden="true" />
                  Live Now
                </div>
                <div className="text-sm font-semibold text-white mt-0.5">
                  {liveUsers.length === 0 ? (
                    'Just you'
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-flex -space-x-1">
                        {liveUsers.slice(0, 6).map((u) => (
                          <span
                            key={u.clientId}
                            title={`${u.name}${u.activity === 'editing' ? ' — writing' : ' — reading'}`}
                            className="w-3.5 h-3.5 rounded-full border border-black/60"
                            style={{ backgroundColor: u.color }}
                          />
                        ))}
                      </span>
                      {liveUsers.length}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>


        {/* 3 Core Services Live Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          {/* TiDB Cluster A (Books) */}
          <div className="p-6 rounded-2xl bg-[#0f131a]/70 backdrop-blur-xl border border-white/10 relative overflow-hidden hover:border-white/20 transition-all group">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">TiDB Cluster A</h4>
                  <p className="text-[11px] text-[#a89f91]">Books & Pages Database</p>
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  health?.primary.books.ok
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {health?.primary.books.ok ? 'Online' : 'Offline'}
              </span>
            </div>

            <div className="space-y-2.5 text-xs text-[#a89f91]">
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Latency</span>
                <span className="font-mono text-white font-medium">
                  {health?.primary.books.latencyMs ?? '--'} ms
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Cluster Quota</span>
                <span className="text-white font-medium">{formatQuota(health?.shiftEngine.books.quotaBytes)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>10MB Threshold Check</span>
                <span
                  className={`font-semibold ${
                    health?.shiftEngine.books.isUnder10MB ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {health?.shiftEngine.books.isUnder10MB ? '< 10MB (Shifted)' : 'Safe (> 10MB)'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span>Routing Target</span>
                <span className="text-[#f0d17c] font-medium">
                  {health?.shiftEngine.books.targetEngine}
                </span>
              </div>
            </div>
          </div>

          {/* TiDB Cluster B (Notes) */}
          <div className="p-6 rounded-2xl bg-[#0f131a]/70 backdrop-blur-xl border border-white/10 relative overflow-hidden hover:border-white/20 transition-all group">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
                  <Layers className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">TiDB Cluster B</h4>
                  <p className="text-[11px] text-[#a89f91]">Margin & Board Notes</p>
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  health?.primary.notes.ok
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {health?.primary.notes.ok ? 'Online' : 'Offline'}
              </span>
            </div>

            <div className="space-y-2.5 text-xs text-[#a89f91]">
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Latency</span>
                <span className="font-mono text-white font-medium">
                  {health?.primary.notes.latencyMs ?? '--'} ms
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Cluster Quota</span>
                <span className="text-white font-medium">{formatQuota(health?.shiftEngine.notes.quotaBytes)}</span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>10MB Threshold Check</span>
                <span
                  className={`font-semibold ${
                    health?.shiftEngine.notes.isUnder10MB ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {health?.shiftEngine.notes.isUnder10MB ? '< 10MB (Shifted)' : 'Safe (> 10MB)'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span>Routing Target</span>
                <span className="text-[#f0d17c] font-medium">
                  {health?.shiftEngine.notes.targetEngine}
                </span>
              </div>
            </div>
          </div>

          {/* CockroachDB Backup Engine (overflow & failover) */}
          <div className="p-6 rounded-2xl bg-[#0f131a]/70 backdrop-blur-xl border border-emerald-500/20 relative overflow-hidden hover:border-emerald-500/40 transition-all group shadow-lg shadow-emerald-500/5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">CockroachDB Engine</h4>
                  <p className="text-[11px] text-emerald-400/80">Dynamic Overflow & Failover</p>
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  health?.overflow.turso.ok
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {health?.overflow.turso.ok ? 'Online (Armed)' : 'Offline'}
              </span>
            </div>

            <div className="space-y-2.5 text-xs text-[#a89f91]">
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Latency</span>
                <span className="font-mono text-white font-medium">
                  {health?.overflow.turso.latencyMs ?? '--'} ms
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Capacity</span>
                <span className="text-white font-medium" title={health?.overflow.quotaSource ?? ''}>
                  {formatQuota(health?.overflow.quotaBytes)}
                </span>
              </div>
              <div className="flex justify-between py-1 border-b border-white/5">
                <span>Trigger Rule</span>
                <span className="text-emerald-300 font-semibold">TiDB &lt; 10MB Remaining</span>
              </div>
              <div className="flex justify-between py-1">
                <span>Current State</span>
                <span
                  className={`font-semibold ${
                    isShiftActive ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {isShiftActive ? 'Receiving Shifted Data' : 'Standby / Armed'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Comprehensive Real-Time Diagnostics Activity Logs */}
        <section className="p-6 md:p-8 rounded-2xl bg-[#0a0d13]/90 backdrop-blur-xl border border-white/10 shadow-2xl">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-white/10 mb-5">
            <div>
              <div className="flex items-center gap-2 text-[#f0d17c] font-serif text-lg">
                <Terminal className="w-5 h-5 text-emerald-400" />
                <span>System & Database Activity Logs</span>
              </div>
              <p className="text-xs text-[#a89f91] mt-0.5">
                Real-time stream of all created, edited, removed, restored, and storage shift events.
              </p>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handleClearLogs}
                disabled={clearingLogs}
                className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] hover:bg-white/[0.08] text-[#a89f91] hover:text-white border border-white/10 transition-all cursor-pointer"
              >
                Clear Event Logs
              </button>
              <div className="text-[11px] text-[#a89f91] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/40 border border-white/5">
                <Clock className="w-3 h-3 text-[#f0d17c]" />
                Last check: {lastRefreshed || 'Just now'}
              </div>
            </div>
          </div>

          {/* Action Filter Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-3 mb-4 text-xs">
            <span className="text-[#a89f91] flex items-center gap-1 mr-2 text-[11px] uppercase tracking-wider">
              <Filter className="w-3 h-3" /> Filter:
            </span>
            {[
              { id: 'all', label: 'All Events', count: health?.activityLogs.length ?? 0 },
              { id: 'create', label: 'Created', count: health?.activityLogs.filter((l) => l.action === 'create').length ?? 0 },
              { id: 'edit', label: 'Edited', count: health?.activityLogs.filter((l) => l.action === 'edit').length ?? 0 },
              { id: 'delete', label: 'Removed', count: health?.activityLogs.filter((l) => l.action === 'delete').length ?? 0 },
              { id: 'shift', label: 'Shift & Fallback', count: health?.activityLogs.filter((l) => l.action === 'shift').length ?? 0 },
              { id: 'diagnostic', label: 'Diagnostics', count: health?.activityLogs.filter((l) => l.action === 'diagnostic').length ?? 0 },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1 rounded-lg font-medium transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'bg-[#f0d17c]/20 text-[#f0d17c] border border-[#f0d17c]/40 font-semibold'
                    : 'bg-white/[0.03] text-[#a89f91] hover:text-white border border-white/5'
                }`}
              >
                <span>{tab.label}</span>
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-black/40 text-white/70">
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Logs List Console */}
          <div className="space-y-2 max-h-[380px] overflow-y-auto pr-2 font-mono text-xs">
            {filteredLogs.length > 0 ? (
              filteredLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-3 rounded-xl bg-black/40 border border-white/5 hover:border-white/10 transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                >
                  <div className="flex items-start sm:items-center gap-3">
                    <span className="text-[11px] text-[#a89f91] flex-shrink-0 font-mono">
                      {log.timeFormatted}
                    </span>
                    {getActionBadge(log.action)}
                    <div>
                      <span className="text-white font-semibold mr-2">{log.title}:</span>
                      <span className="text-[#c8c2b7]">{log.details}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                        log.engine === 'CockroachDB' || log.engine === 'Turso LibSQL'
                          ? 'bg-purple-500/10 text-purple-300 border border-purple-500/20'
                          : log.engine.includes('TiDB')
                          ? 'bg-blue-500/10 text-blue-300 border border-blue-500/20'
                          : 'bg-white/5 text-[#a89f91]'
                      }`}
                    >
                      {log.engine}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="p-8 text-center text-[#a89f91] italic bg-black/20 rounded-xl border border-white/5">
                No events recorded for this category yet. Create, edit, or remove notes inside Libris to watch live events appear!
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
