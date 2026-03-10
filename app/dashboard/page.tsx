'use client'

import { useEffect, useState, useCallback } from 'react'
import { SkeletonCards, SkeletonBlock } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'

/* ─── types ─── */
interface JobCounts { active: number; waiting: number; completed: number; failed: number }
interface DailyPoint { date: string; groq: number; openai: number; total: number }
interface CategoryItem { name: string; count: number }
interface ShowItem { name: string; total: number; summarized: number }
interface RecentEp { id: number; show_name: string | null; headline: string | null; status: string; updated_at: string; air_date: string | null; issue_category: string | null }
interface ActivityItem { id: number; show_name: string | null; headline: string | null; status: string; show_key?: string; time: string; duration_seconds?: number | null; cost?: number | null }
interface TimeEstimate { count: number; avgSeconds?: number; totalMinutes: number }
interface QualityFlag { id: number; show_name: string | null; headline: string | null; air_date: string | null; reason: string }
interface DashData {
  quarter: { year: number; quarter: number; start: string; end: string; label: string }
  counts: { all: Record<string, number>; quarter: Record<string, number> }
  queues: { ingest: JobCounts; transcribe: JobCounts; summarize: JobCounts; compliance: JobCounts }
  cost: {
    quarter: { groq: number; openai: number; total: number; episodeCount: number; apiCalls: number }
    daily: DailyPoint[]
    month: { groq: number; openai: number; total: number }
  }
  categories: CategoryItem[]
  shows: ShowItem[]
  recentEpisodes: RecentEp[]
  activity24h: ActivityItem[]
  avgProcessingTimes: Record<string, number>
  timeEstimates: {
    transcription: TimeEstimate | null
    summarization: TimeEstimate | null
    compliance: TimeEstimate | null
  }
  qirReadiness: {
    coveredCategories: string[]
    totalCategories: number
    missingCategories: string[]
  }
  coverageGaps: string[]
  complianceSummary: Record<string, { count: number; critical: number }>
  qirStatus: { status: string; version: number; entryCount: number } | null
  qualityFlags: QualityFlag[]
  lastFiledQir: { id: number; year: number; quarter: number; version: number; updated_at: string } | null
  pipelinePaused: boolean
  pipelineMode: 'constant' | 'surgical'
}

const BADGE_COLORS: Record<string, string> = {
  pending:             'bg-amber-100/80 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  transcribed:         'bg-blue-100/80 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  summarized:          'bg-emerald-100/80 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  compliance_checked:  'bg-emerald-100/80 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  failed:              'bg-red-100/80 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  unavailable:         'bg-warm-200 text-warm-500 dark:bg-warm-700 dark:text-warm-400',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  transcribed: 'Transcribed',
  summarized: 'Summarized',
  compliance_checked: 'Checked',
  failed: 'Failed',
  unavailable: 'Unavailable',
}

const STATUS_CELL_BG: Record<string, string> = {
  pending:             'bg-amber-50 border-amber-100 dark:bg-amber-900/20 dark:border-amber-800/40',
  transcribed:         'bg-blue-50 border-blue-100 dark:bg-blue-900/20 dark:border-blue-800/40',
  summarized:          'bg-emerald-50 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800/40',
  compliance_checked:  'bg-emerald-50/60 border-emerald-100 dark:bg-emerald-900/15 dark:border-emerald-800/40',
  failed:              'bg-red-50 border-red-100 dark:bg-red-900/20 dark:border-red-800/40',
  unavailable:         'bg-warm-50 border-warm-200 dark:bg-warm-800 dark:border-warm-700',
}

const FLAG_LABELS: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Missing Station ID',
  technical: 'Technical',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID',
  indecency: 'Indecency',
}

/* ─── helpers ─── */
function fmtCost(n: number) { return '$' + n.toFixed(2) }
function fmtDur(mins: number) {
  if (mins < 1) return '<1 min'
  if (mins < 60) return `~${Math.round(mins)} min`
  const h = Math.floor(mins / 60)
  const m = Math.round(mins % 60)
  return m > 0 ? `~${h}h ${m}m` : `~${h}h`
}
function fmtSecs(secs: number) {
  if (secs < 60) return `${Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}
function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function getDayLabel(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today.getTime() - 86400000)
  const entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())

  if (entryDate.getTime() === today.getTime()) return 'TODAY'
  if (entryDate.getTime() === yesterday.getTime()) return 'YESTERDAY'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

function getNextIngestMinutes(): number {
  const now = new Date()
  const currentMinute = now.getMinutes()
  if (currentMinute < 2) return 2 - currentMinute
  return 62 - currentMinute
}

const STATUS_VERB: Record<string, string> = {
  pending: 'Ingested',
  transcribed: 'Transcribed',
  summarized: 'Summarized',
  compliance_checked: 'Compliance checked',
  failed: 'Failed',
  unavailable: 'Unavailable',
}

/* ─── main dashboard ─── */
export default function DashboardOverview() {
  const [data, setData] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [gapsCollapsed, setGapsCollapsed] = useState(false)
  const [nextIngest, setNextIngest] = useState(getNextIngestMinutes())
  const { toast } = useToast()

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard')
      if (res.ok) setData(await res.json())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])
  useEffect(() => {
    const interval = setInterval(fetchData, 15000)
    return () => clearInterval(interval)
  }, [fetchData])

  useEffect(() => {
    const timer = setInterval(() => setNextIngest(getNextIngestMinutes()), 30000)
    return () => clearInterval(timer)
  }, [])

  async function togglePause() {
    const action = data?.pipelinePaused ? 'resume_pipeline' : 'pause_pipeline'
    setActionLoading('pause')
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        toast('error', 'Failed to toggle pipeline')
        return
      }
      toast('success', action === 'pause_pipeline' ? 'Pipeline paused' : 'Pipeline resumed')
      setTimeout(fetchData, 1000)
    } catch {
      toast('error', 'Network error')
    } finally {
      setActionLoading(null)
    }
  }

  async function toggleMode() {
    const newMode = data?.pipelineMode === 'constant' ? 'surgical' : 'constant'
    setActionLoading('mode')
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_pipeline_mode', mode: newMode }),
      })
      if (!res.ok) {
        toast('error', 'Failed to switch mode')
        return
      }
      toast('success', `Switched to ${newMode} mode`)
      setTimeout(fetchData, 1000)
    } catch {
      toast('error', 'Network error')
    } finally {
      setActionLoading(null)
    }
  }

  async function triggerAction(action: string) {
    setActionLoading(action)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        toast('error', d.error ?? `Failed to queue ${action}`)
        return
      }
      toast('success', `${action} job queued`)
      setTimeout(fetchData, 2000)
    } catch {
      toast('error', 'Network error')
    } finally {
      setActionLoading(null)
    }
  }

  async function retryEpisode(id: number) {
    setActionLoading(`retry-${id}`)
    try {
      const res = await fetch(`/api/episodes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      })
      if (!res.ok) {
        toast('error', 'Failed to retry episode')
        return
      }
      toast('success', 'Episode queued for retry')
      setTimeout(fetchData, 2000)
    } catch {
      toast('error', 'Network error')
    } finally {
      setActionLoading(null)
    }
  }

  async function markUnavailable(id: number) {
    setActionLoading(`unavail-${id}`)
    try {
      const res = await fetch(`/api/episodes/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'unavailable' }),
      })
      if (!res.ok) {
        toast('error', 'Failed to mark episode unavailable')
        return
      }
      toast('success', 'Episode marked unavailable')
      setTimeout(fetchData, 2000)
    } catch {
      toast('error', 'Network error')
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) return (
    <div className="space-y-6 max-w-[1400px] animate-fade-in">
      <div className="h-12 bg-warm-100 dark:bg-warm-700 rounded-xl animate-pulse" />
      <div className="h-14 bg-warm-100 dark:bg-warm-700 rounded-xl animate-pulse" />
      <SkeletonCards count={5} />
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )

  if (!data) return <div className="text-red-600 card p-6">Failed to load dashboard data.</div>

  const { counts, queues, cost, categories, activity24h, timeEstimates, qirReadiness, coverageGaps, complianceSummary, qirStatus, qualityFlags, pipelinePaused, pipelineMode } = data
  const qtrCounts = counts.quarter
  const qtrTotal = Object.values(qtrCounts).reduce((a, b) => a + b, 0)
  const qtrComplete = (qtrCounts.summarized ?? 0) + (qtrCounts.compliance_checked ?? 0)
  const qtrPct = qtrTotal > 0 ? Math.round((qtrComplete / qtrTotal) * 100) : 0

  const totalActive = queues.ingest.active + queues.transcribe.active + queues.summarize.active + queues.compliance.active
  const anyProcessing = totalActive > 0 || queues.ingest.waiting + queues.transcribe.waiting + queues.summarize.waiting + queues.compliance.waiting > 0

  const activeJobs: { stage: string; count: number }[] = []
  if (queues.ingest.active > 0) activeJobs.push({ stage: 'Ingesting', count: queues.ingest.active })
  if (queues.transcribe.active > 0) activeJobs.push({ stage: 'Transcribing', count: queues.transcribe.active })
  if (queues.summarize.active > 0) activeJobs.push({ stage: 'Summarizing', count: queues.summarize.active })
  if (queues.compliance.active > 0) activeJobs.push({ stage: 'Compliance check', count: queues.compliance.active })

  const totalFlags = Object.values(complianceSummary).reduce((a, b) => a + b.count, 0)
  const totalCritical = Object.values(complianceSummary).reduce((a, b) => a + b.critical, 0)

  const failedEpisodes = data.recentEpisodes.filter((ep) => ep.status === 'failed')
  const attentionCount = failedEpisodes.length + (qualityFlags?.length ?? 0)

  const readinessLevel = qirReadiness.coveredCategories.length >= 5 ? 'good'
    : qirReadiness.coveredCategories.length >= 3 ? 'warn' : 'bad'
  const readinessStyles: Record<string, string> = {
    good: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-800/40',
    warn: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-900/20 dark:border-amber-800/40',
    bad: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-900/20 dark:border-red-800/40',
  }

  const activityByDay: { label: string; items: ActivityItem[] }[] = []
  let currentDayLabel = ''
  for (const item of activity24h) {
    const dayLabel = getDayLabel(item.time)
    if (dayLabel !== currentDayLabel) {
      currentDayLabel = dayLabel
      activityByDay.push({ label: dayLabel, items: [] })
    }
    activityByDay[activityByDay.length - 1].items.push(item)
  }

  const dayOfMonth = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const monthlyProjection = dayOfMonth > 0 ? (cost.month.total / dayOfMonth) * daysInMonth : 0

  return (
    <div className="space-y-5 max-w-[1400px] animate-fade-in">

      {/* ═══ 1. ON AIR STATUS STRIP ═══ */}
      <div className={`rounded-xl border px-5 py-3.5 flex items-center justify-between transition-all duration-300 ${
        pipelinePaused
          ? 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/40'
          : anyProcessing
            ? 'bg-gradient-to-r from-kpfk-cream to-kpfk-cream-dark border-kpfk-gold/25 shadow-glow-gold dark:from-warm-800 dark:to-warm-800 dark:border-kpfk-gold-dark/30 dark:shadow-glow-gold-dark'
            : 'bg-white border-warm-200 dark:bg-surface-raised dark:border-warm-700'
      }`}>
        <div className="flex items-center gap-4">
          {pipelinePaused ? (
            <div className="flex items-center gap-2.5">
              <span className="inline-flex rounded-full h-3 w-3 bg-red-500" />
              <span className="text-xs font-semibold text-red-700 dark:text-red-300 uppercase tracking-wider">Paused</span>
              <span className="text-sm text-red-500 dark:text-red-400">Pipeline is stopped — no jobs will run</span>
            </div>
          ) : anyProcessing ? (
            <>
              <div className="flex items-center gap-2.5">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-kpfk-gold opacity-60" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-kpfk-gold" />
                </span>
                <span className="text-xs font-semibold text-warm-700 dark:text-warm-200 uppercase tracking-wider">Processing</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-warm-500">
                {activeJobs.map((j) => (
                  <span key={j.stage} className="tabular-nums">{j.stage} ({j.count})</span>
                ))}
                {activeJobs.length === 0 && (
                  <span className="tabular-nums">{queues.ingest.waiting + queues.transcribe.waiting + queues.summarize.waiting + queues.compliance.waiting} queued</span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2.5">
              <span className="dot dot-md bg-emerald-400" />
              <span className="text-sm text-warm-400">All caught up</span>
            </div>
          )}
          {!pipelinePaused && pipelineMode === 'constant' && (
            <span className="text-2xs text-warm-400 hidden md:inline tabular-nums">
              Next ingest in {nextIngest} min
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle: Constant / Surgical */}
          <div className="flex rounded-lg border border-warm-200 dark:border-warm-600 overflow-hidden mr-1">
            <button
              onClick={() => { if (pipelineMode !== 'constant') toggleMode() }}
              disabled={actionLoading !== null}
              className={`text-xs font-medium px-3 py-1.5 transition-colors ${
                pipelineMode === 'constant'
                  ? 'bg-kpfk-gold/20 text-kpfk-gold-dark border-r border-warm-200 dark:bg-kpfk-gold-dark/20 dark:text-kpfk-gold dark:border-warm-600'
                  : 'bg-white text-warm-400 hover:bg-warm-50 border-r border-warm-200 dark:bg-warm-800 dark:text-warm-500 dark:hover:bg-warm-700 dark:border-warm-600'
              }`}
              title="Fully automated — cron ingests, auto-chains all stages"
            >
              {actionLoading === 'mode' && pipelineMode !== 'constant' ? (
                <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full inline-block" />
              ) : 'Constant'}
            </button>
            <button
              onClick={() => { if (pipelineMode !== 'surgical') toggleMode() }}
              disabled={actionLoading !== null}
              className={`text-xs font-medium px-3 py-1.5 transition-colors ${
                pipelineMode === 'surgical'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                  : 'bg-white text-warm-400 hover:bg-warm-50 dark:bg-warm-800 dark:text-warm-500 dark:hover:bg-warm-700'
              }`}
              title="Manual only — you trigger each stage, nothing runs automatically"
            >
              {actionLoading === 'mode' && pipelineMode !== 'surgical' ? (
                <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full inline-block" />
              ) : 'Surgical'}
            </button>
          </div>
          <button
            onClick={togglePause}
            disabled={actionLoading !== null}
            className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              pipelinePaused
                ? 'bg-emerald-100 border-emerald-300 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-300'
                : 'bg-red-100 border-red-300 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:border-red-700 dark:text-red-300'
            }`}
          >
            {actionLoading === 'pause' ? (
              <span className="animate-spin h-3 w-3 border-2 border-current border-t-transparent rounded-full inline-block" />
            ) : pipelinePaused ? 'Resume' : 'Pause'}
          </button>
          {/* Manual trigger buttons — always available (they're the point of surgical mode) */}
          {!pipelinePaused && (['ingest', 'transcribe', 'summarize', 'compliance'] as const).map((action) => (
            <button
              key={action}
              onClick={() => triggerAction(action)}
              disabled={actionLoading !== null}
              className="action-btn-primary"
            >
              {actionLoading === action ? (
                <span className="flex items-center gap-1">
                  <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />
                </span>
              ) : (
                action.charAt(0).toUpperCase() + action.slice(1)
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ 2. QUARTER SCOREBOARD ═══ */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-warm-900 dark:text-warm-50">{data.quarter.label}</h2>
          {qirStatus && (
            <a href="/dashboard/generate" className={`badge text-xs px-3 py-1 rounded-full border ${
              qirStatus.status === 'final' ? 'bg-emerald-50 border-emerald-200 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800/40 dark:text-emerald-300' : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-900/20 dark:border-amber-800/40 dark:text-amber-300'
            }`}>
              QIR: {qirStatus.status === 'final' ? 'Finalized' : 'Draft'} (v{qirStatus.version}, {qirStatus.entryCount} entries)
            </a>
          )}
          {!qirStatus && (
            <a href="/dashboard/generate" className="badge text-xs px-3 py-1 rounded-full border border-warm-200 text-warm-400 dark:border-warm-600 dark:text-warm-500 hover:border-warm-400 transition-colors">
              QIR: Not generated
            </a>
          )}
        </div>

        {/* Big numbers with color fills */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-5">
          {([
            ['pending', qtrCounts.pending ?? 0],
            ['transcribed', qtrCounts.transcribed ?? 0],
            ['summarized', qtrCounts.summarized ?? 0],
            ['compliance_checked', qtrCounts.compliance_checked ?? 0],
            ['failed', qtrCounts.failed ?? 0],
            ['unavailable', qtrCounts.unavailable ?? 0],
          ] as [string, number][]).map(([status, count]) => (
            <a
              key={status}
              href={`/dashboard/episodes?status=${status}&quarter=${data.quarter.year}-Q${data.quarter.quarter}`}
              className={`text-center p-3.5 rounded-xl border hover:shadow-card-hover transition-all duration-200 ${STATUS_CELL_BG[status] ?? 'bg-warm-50 border-warm-200'}`}
            >
              <p className="text-2xl font-bold text-warm-900 dark:text-warm-100 tabular-nums">{count}</p>
              <p className="text-2xs text-warm-500 mt-0.5">{STATUS_LABELS[status] ?? status}</p>
            </a>
          ))}
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs text-warm-500 mb-1.5">
            <span>Pipeline completion</span>
            <span className="font-medium text-warm-700 dark:text-warm-300 tabular-nums">{qtrPct}% ({qtrComplete}/{qtrTotal})</span>
          </div>
          <div className="progress-track h-2.5 bg-warm-100 dark:bg-warm-700">
            <div className="progress-fill bg-kpfk-red h-2.5" style={{ width: `${qtrPct}%` }} />
          </div>
        </div>
      </div>

      {/* ═══ 3. QIR READINESS + 4. TIME ESTIMATES ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* QIR Readiness */}
        <div className={`rounded-xl border p-5 ${readinessStyles[readinessLevel]}`}>
          <h3 className="section-header mb-3 opacity-70">QIR Readiness</h3>
          <p className="text-lg font-bold mb-2 tabular-nums">
            {qirReadiness.coveredCategories.length} of {qirReadiness.totalCategories} categories covered
          </p>
          {qirReadiness.missingCategories.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1.5 opacity-70">Missing:</p>
              <div className="flex flex-wrap gap-1.5">
                {qirReadiness.missingCategories.map((cat) => (
                  <span key={cat} className="text-2xs px-2 py-0.5 rounded-full bg-white/50 border border-current/10">{cat}</span>
                ))}
              </div>
            </div>
          )}
          {qirReadiness.missingCategories.length === 0 && (
            <p className="text-sm">All FCC issue categories are covered. Ready to generate QIR.</p>
          )}
        </div>

        {/* Time Estimates */}
        <div className="card p-5">
          <h3 className="section-header mb-3">Time Estimates</h3>
          {!timeEstimates.transcription && !timeEstimates.summarization && !timeEstimates.compliance ? (
            <div className="flex items-center gap-2.5 text-sm text-warm-400">
              <span className="dot dot-md bg-emerald-400" />
              All caught up
            </div>
          ) : (
            <div className="space-y-3">
              {timeEstimates.transcription && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-warm-500">Transcription</span>
                  <span className="font-medium text-warm-800 dark:text-warm-200 tabular-nums">
                    {fmtDur(timeEstimates.transcription.totalMinutes)} ({timeEstimates.transcription.count} episodes)
                  </span>
                </div>
              )}
              {timeEstimates.summarization && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-warm-500">Summarization</span>
                  <span className="font-medium text-warm-800 dark:text-warm-200 tabular-nums">
                    {fmtDur(timeEstimates.summarization.totalMinutes)} ({timeEstimates.summarization.count} episodes)
                  </span>
                </div>
              )}
              {timeEstimates.compliance && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-warm-500">Compliance</span>
                  <span className="font-medium text-warm-800 dark:text-warm-200 tabular-nums">
                    {fmtDur(timeEstimates.compliance.totalMinutes)} ({timeEstimates.compliance.count} episodes)
                  </span>
                </div>
              )}
              <div className="pt-2 border-t border-warm-100 dark:border-warm-700 text-xs text-warm-400 dark:text-warm-500 tabular-nums">
                Pipeline clear in {fmtDur(
                  (timeEstimates.transcription?.totalMinutes ?? 0) +
                  (timeEstimates.summarization?.totalMinutes ?? 0) +
                  (timeEstimates.compliance?.totalMinutes ?? 0)
                )} at current pace
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ═══ 5. BROADCAST LOG ═══ */}
      <div className="card overflow-hidden">
        <div className="px-5 py-3.5 border-b border-warm-100 dark:border-warm-700 flex items-center justify-between">
          <h3 className="section-header">Broadcast Log</h3>
          <span className="text-2xs text-warm-400 tabular-nums">Last {activity24h.length} events</span>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {activityByDay.length > 0 ? activityByDay.map((group) => (
            <div key={group.label}>
              <div className="sticky top-0 z-10 bg-warm-50 dark:bg-surface px-5 py-1.5 border-b border-warm-100 dark:border-warm-700">
                <span className="text-2xs font-semibold text-warm-400 tracking-wider">{group.label}</span>
                <span className="text-2xs text-warm-300 ml-2 tabular-nums">{group.items.length} events</span>
              </div>
              <div className="divide-y divide-warm-50 dark:divide-warm-700">
                {group.items.map((item, i) => (
                  <a
                    key={`${item.id}-${i}`}
                    href={`/dashboard/episodes/${item.id}`}
                    className="log-entry"
                  >
                    <span className="text-xs text-warm-400 w-20 shrink-0 font-mono tabular-nums">{fmtTime(item.time)}</span>
                    <span className="text-warm-300 shrink-0">—</span>
                    <span className={`badge shrink-0 ${BADGE_COLORS[item.status] ?? 'bg-warm-100 text-warm-500'}`}>
                      {STATUS_VERB[item.status] ?? item.status}
                    </span>
                    <span className="text-sm text-warm-700 truncate">{item.show_name ?? `#${item.id}`}</span>
                    {item.headline && <span className="text-xs text-warm-400 truncate hidden lg:inline">— {item.headline}</span>}
                    <span className="text-2xs text-warm-400 shrink-0 ml-auto flex items-center gap-2 tabular-nums">
                      {item.status === 'transcribed' && item.duration_seconds != null && (
                        <span className="text-blue-500">{fmtSecs(item.duration_seconds)}</span>
                      )}
                      {(item.status === 'summarized' || item.status === 'compliance_checked') && item.cost != null && (
                        <span className="text-emerald-600">{fmtCost(item.cost)}</span>
                      )}
                      {timeAgo(item.time)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )) : (
            <p className="px-5 py-6 text-sm text-warm-400">No recent activity</p>
          )}
        </div>
      </div>

      {/* ═══ 6. ATTENTION NEEDED + COMPLIANCE ═══ */}
      {(attentionCount > 0 || totalFlags > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {attentionCount > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 border-b border-warm-100 dark:border-warm-700 flex items-center justify-between">
                <h3 className="section-header">Attention Needed</h3>
                <span className="badge bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 tabular-nums">{attentionCount}</span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {failedEpisodes.length > 0 && failedEpisodes.map((ep) => (
                  <div key={ep.id} className="flex items-center gap-3 px-5 py-2.5 border-b border-warm-50 dark:border-warm-700 last:border-0 hover:bg-red-50/40 dark:hover:bg-red-900/20 transition-colors">
                    <a href={`/dashboard/episodes/${ep.id}`} className="text-sm text-warm-700 dark:text-warm-300 truncate flex-1">{ep.show_name ?? `#${ep.id}`}</a>
                    <span className="text-xs text-warm-400 shrink-0 tabular-nums">{ep.air_date ?? ''}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); retryEpisode(ep.id) }}
                      disabled={actionLoading !== null}
                      className="text-2xs px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50 disabled:opacity-40 font-medium transition-colors"
                    >
                      {actionLoading === `retry-${ep.id}` ? '...' : 'Retry'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); markUnavailable(ep.id) }}
                      disabled={actionLoading !== null}
                      className="text-2xs px-2.5 py-1 rounded-lg bg-warm-100 text-warm-500 hover:bg-warm-200 dark:bg-warm-700 dark:text-warm-400 dark:hover:bg-warm-600 disabled:opacity-40 font-medium transition-colors"
                    >
                      {actionLoading === `unavail-${ep.id}` ? '...' : 'Unavail'}
                    </button>
                  </div>
                ))}
                {qualityFlags && qualityFlags.length > 0 && (
                  <>
                    {failedEpisodes.length > 0 && (
                      <div className="px-5 py-1.5 bg-warm-50 border-b border-warm-100">
                        <span className="text-2xs font-semibold text-warm-400 uppercase tracking-wider">Quality Flags</span>
                      </div>
                    )}
                    {qualityFlags.map((flag) => (
                      <a key={flag.id} href={`/dashboard/episodes/${flag.id}`} className="flex items-center gap-3 px-5 py-2.5 border-b border-warm-50 last:border-0 hover:bg-amber-50/40 transition-colors">
                        <span className="badge bg-amber-100 text-amber-700 shrink-0">Quality</span>
                        <span className="text-sm text-warm-700 truncate flex-1">{flag.show_name ?? `#${flag.id}`}</span>
                        <span className="text-2xs text-warm-400 shrink-0 hidden md:inline">{flag.reason}</span>
                      </a>
                    ))}
                  </>
                )}
                {failedEpisodes.length === 0 && (!qualityFlags || qualityFlags.length === 0) && (
                  <p className="px-5 py-4 text-sm text-emerald-600">No issues</p>
                )}
              </div>
            </div>
          )}

          {totalFlags > 0 && (
            <div className="card overflow-hidden">
              <div className="px-5 py-3.5 border-b border-warm-100 dark:border-warm-700 flex items-center justify-between">
                <h3 className="section-header">Compliance</h3>
                <span className={`badge tabular-nums ${totalCritical > 0 ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>
                  {totalFlags} unresolved
                </span>
              </div>
              <div className="px-5 py-4">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(complianceSummary).map(([type, { count, critical }]) => (
                    <a
                      key={type}
                      href={`/dashboard/compliance?type=${type}`}
                      className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                        critical > 0 ? 'bg-red-50 border-red-200 text-red-700 hover:bg-red-100 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-300 dark:hover:bg-red-900/30' : 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/20 dark:border-amber-800/40 dark:text-amber-300 dark:hover:bg-amber-900/30'
                      }`}
                    >
                      {count} {FLAG_LABELS[type] ?? type}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ 7. SHOW COVERAGE GAPS ═══ */}
      {coverageGaps.length > 0 && (
        <div className="card overflow-hidden">
          <button
            onClick={() => setGapsCollapsed(!gapsCollapsed)}
            className="w-full px-5 py-3.5 flex items-center justify-between hover:bg-warm-50 dark:hover:bg-warm-700/50 transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <h3 className="section-header">Show Coverage Gaps</h3>
              <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 tabular-nums">{coverageGaps.length}</span>
            </div>
            <span className={`text-warm-400 text-xs transition-transform duration-200 ${gapsCollapsed ? '' : 'rotate-90'}`}>▶</span>
          </button>
          {!gapsCollapsed && (
            <div className="px-5 pb-5 animate-fade-in">
              <p className="text-xs text-warm-500 mb-2.5">Active shows with no summarized episodes this quarter:</p>
              <div className="flex flex-wrap gap-1.5">
                {coverageGaps.map((name) => (
                  <a
                    key={name}
                    href={`/dashboard/episodes?show=${encodeURIComponent(name)}&quarter=${data.quarter.year}-Q${data.quarter.quarter}`}
                    className="text-xs px-2.5 py-1 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/20 dark:border-amber-800/40 dark:text-amber-300 dark:hover:bg-amber-900/30 transition-colors"
                  >
                    {name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ 8. COST THIS MONTH ═══ */}
      <div className="card px-5 py-3.5 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4 text-sm text-warm-500 flex-wrap">
          <span className="font-semibold text-warm-800 dark:text-warm-200">
            {new Date().toLocaleString('en-US', { month: 'long' })} spend: {fmtCost(cost.month.total)}
          </span>
          <span className="text-xs text-warm-400 tabular-nums">
            Groq {fmtCost(cost.month.groq)} / OpenAI {fmtCost(cost.month.openai)}
          </span>
          {cost.quarter.episodeCount > 0 && (
            <span className="text-xs text-warm-400 tabular-nums">
              avg ${(cost.quarter.total / cost.quarter.episodeCount).toFixed(3)}/episode
            </span>
          )}
          {dayOfMonth > 1 && (
            <span className="text-xs text-warm-400 tabular-nums">
              projected: {fmtCost(monthlyProjection)}/mo
            </span>
          )}
        </div>
        <a href="/dashboard/usage" className="text-xs text-warm-400 hover:text-warm-600 transition-colors">Details →</a>
      </div>

      {/* ═══ BOTTOM ROW: Categories + Recent Episodes ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Issue Categories */}
        <div className="card p-5">
          <h3 className="section-header mb-4">Issue Categories</h3>
          {categories.length > 0 ? (
            <div className="space-y-2.5">
              {categories.map((c, i) => {
                const max = categories[0]?.count ?? 1
                const colors = ['bg-kpfk-red', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500', 'bg-cyan-500']
                return (
                  <a
                    key={c.name}
                    href={`/dashboard/episodes?category=${encodeURIComponent(c.name)}&quarter=${data.quarter.year}-Q${data.quarter.quarter}`}
                    className="block hover:bg-warm-50 dark:hover:bg-warm-700/50 rounded-lg transition-colors -mx-1 px-1 py-0.5"
                  >
                    <div className="flex justify-between text-xs mb-1">
                      <span className="text-warm-700 dark:text-warm-300 truncate mr-2">{c.name}</span>
                      <span className="text-warm-400 dark:text-warm-500 shrink-0 tabular-nums">{c.count}</span>
                    </div>
                    <div className="progress-track h-2 bg-warm-100 dark:bg-warm-700">
                      <div
                        className={`progress-fill h-2 ${colors[i % colors.length]}`}
                        style={{ width: `${max > 0 ? (c.count / max) * 100 : 0}%` }}
                      />
                    </div>
                  </a>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-warm-400">No categorized episodes yet</p>
          )}
        </div>

        {/* Recent Episodes */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3.5 border-b border-warm-100 dark:border-warm-700 flex items-center justify-between">
            <h3 className="section-header">Recent Episodes</h3>
            <a href="/dashboard/episodes" className="text-xs text-kpfk-red hover:text-kpfk-red-dark transition-colors">View all →</a>
          </div>
          <div className="divide-y divide-warm-50 dark:divide-warm-700 max-h-72 overflow-y-auto">
            {data.recentEpisodes.map((ep) => (
              <a key={ep.id} href={`/dashboard/episodes/${ep.id}`} className="log-entry">
                <span className={`badge shrink-0 ${BADGE_COLORS[ep.status] ?? 'bg-warm-100'}`}>
                  {STATUS_LABELS[ep.status] ?? ep.status}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-warm-800 dark:text-warm-200 truncate">{ep.show_name ?? `#${ep.id}`}</p>
                </div>
                <span className="text-2xs text-warm-400 shrink-0 tabular-nums">{ep.air_date ?? timeAgo(ep.updated_at)}</span>
              </a>
            ))}
            {data.recentEpisodes.length === 0 && (
              <p className="px-5 py-6 text-sm text-warm-400">No episodes yet</p>
            )}
          </div>
        </div>
      </div>

      {/* ═══ 9. SYSTEM HEALTH FOOTER ═══ */}
      <SystemHealthFooter queues={queues} activity={activity24h} lastFiled={data.lastFiledQir} paused={pipelinePaused} />
    </div>
  )
}

/* ─── System Health Footer ─── */
function SystemHealthFooter({ queues, activity, lastFiled, paused }: { queues: DashData['queues']; activity: ActivityItem[]; lastFiled: DashData['lastFiledQir']; paused: boolean }) {
  const lastIngest = activity.find((a) => a.status === 'pending')?.time
  const lastTranscribe = activity.find((a) => a.status === 'transcribed')?.time
  const lastSummarize = activity.find((a) => a.status === 'summarized' || a.status === 'compliance_checked')?.time

  function staleness(iso: string | undefined): { label: string; color: string } {
    if (!iso) return { label: 'never', color: 'text-warm-400' }
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (mins < 120) return { label: timeAgo(iso), color: 'text-emerald-600' }
    if (mins < 480) return { label: timeAgo(iso), color: 'text-amber-600' }
    return { label: timeAgo(iso), color: 'text-red-600' }
  }

  const ingestInfo = staleness(lastIngest)
  const transcribeInfo = staleness(lastTranscribe)
  const summarizeInfo = staleness(lastSummarize)

  const workersRunning = queues.ingest.active + queues.transcribe.active + queues.summarize.active + queues.compliance.active > 0
  const workerColor = workersRunning ? 'text-emerald-600' : 'text-red-600'

  return (
    <div className="rounded-xl border border-warm-200 dark:border-warm-700 bg-warm-50 dark:bg-surface-raised px-5 py-3 flex items-center gap-6 text-xs text-warm-500 dark:text-warm-400 flex-wrap tabular-nums">
      <span>Pipeline: <span className={`font-medium ${paused ? 'text-red-600' : 'text-emerald-600'}`}>{paused ? 'paused' : 'active'}</span></span>
      <span>Workers: <span className={`font-medium ${workerColor}`}>{workersRunning ? 'running' : 'idle'}</span></span>
      <span>Last ingest: <span className={`font-medium ${ingestInfo.color}`}>{ingestInfo.label}</span></span>
      <span>Last transcription: <span className={`font-medium ${transcribeInfo.color}`}>{transcribeInfo.label}</span></span>
      <span>Last summarization: <span className={`font-medium ${summarizeInfo.color}`}>{summarizeInfo.label}</span></span>
      {lastFiled && (
        <span>Last QIR filed: <a href={`/${lastFiled.year}/q${lastFiled.quarter}`} className="font-medium text-kpfk-red hover:underline">Q{lastFiled.quarter} {lastFiled.year}</a></span>
      )}
    </div>
  )
}
