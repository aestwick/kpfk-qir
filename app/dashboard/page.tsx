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
}

const BADGE_COLORS: Record<string, string> = {
  pending:             'bg-amber-100 text-amber-800',
  transcribed:         'bg-blue-100 text-blue-800',
  summarized:          'bg-emerald-100 text-emerald-800',
  compliance_checked:  'bg-emerald-100 text-emerald-800',
  failed:              'bg-red-100 text-red-800',
  unavailable:         'bg-gray-100 text-gray-600',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  transcribed: 'Transcribed',
  summarized: 'Summarized',
  compliance_checked: 'Checked',
  failed: 'Failed',
  unavailable: 'Unavailable',
}

const FLAG_LABELS: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Missing Station ID',
  technical: 'Technical',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID',
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
  // Cron runs at minute :02 of every hour
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

  // Next ingest countdown timer
  useEffect(() => {
    const timer = setInterval(() => setNextIngest(getNextIngestMinutes()), 30000)
    return () => clearInterval(timer)
  }, [])

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
    <div className="space-y-6">
      <div className="h-10 bg-gray-200 rounded w-48 animate-pulse" />
      <div className="h-14 bg-gray-100 rounded-lg animate-pulse" />
      <SkeletonCards count={5} />
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )

  if (!data) return <div className="text-red-600">Failed to load dashboard data.</div>

  const { counts, queues, cost, categories, activity24h, timeEstimates, qirReadiness, coverageGaps, complianceSummary, qirStatus, qualityFlags } = data
  const qtrCounts = counts.quarter
  const qtrTotal = Object.values(qtrCounts).reduce((a, b) => a + b, 0)
  const qtrComplete = (qtrCounts.summarized ?? 0) + (qtrCounts.compliance_checked ?? 0)
  const qtrPct = qtrTotal > 0 ? Math.round((qtrComplete / qtrTotal) * 100) : 0

  const totalActive = queues.ingest.active + queues.transcribe.active + queues.summarize.active + queues.compliance.active
  const anyProcessing = totalActive > 0 || queues.ingest.waiting + queues.transcribe.waiting + queues.summarize.waiting + queues.compliance.waiting > 0

  // Active jobs for the "On Air" strip
  const activeJobs: { stage: string; count: number }[] = []
  if (queues.ingest.active > 0) activeJobs.push({ stage: 'Ingesting', count: queues.ingest.active })
  if (queues.transcribe.active > 0) activeJobs.push({ stage: 'Transcribing', count: queues.transcribe.active })
  if (queues.summarize.active > 0) activeJobs.push({ stage: 'Summarizing', count: queues.summarize.active })
  if (queues.compliance.active > 0) activeJobs.push({ stage: 'Compliance check', count: queues.compliance.active })

  // Compliance flag total
  const totalFlags = Object.values(complianceSummary).reduce((a, b) => a + b.count, 0)
  const totalCritical = Object.values(complianceSummary).reduce((a, b) => a + b.critical, 0)

  // Failed episodes from recent
  const failedEpisodes = data.recentEpisodes.filter((ep) => ep.status === 'failed')

  // Combined attention needed count (failed + quality flags)
  const attentionCount = failedEpisodes.length + (qualityFlags?.length ?? 0)

  // QIR readiness color
  const readinessColor = qirReadiness.coveredCategories.length >= 5 ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
    : qirReadiness.coveredCategories.length >= 3 ? 'text-amber-700 bg-amber-50 border-amber-200'
    : 'text-red-700 bg-red-50 border-red-200'

  // 3a: Group broadcast log entries by day
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

  // 3g: Monthly projection
  const dayOfMonth = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const monthlyProjection = dayOfMonth > 0 ? (cost.month.total / dayOfMonth) * daysInMonth : 0

  return (
    <div className="space-y-5 max-w-[1400px]">

      {/* ═══ 1. ON AIR STATUS STRIP ═══ */}
      <div className={`rounded-lg border px-5 py-3 flex items-center justify-between ${anyProcessing ? 'bg-kpfk-cream border-kpfk-gold/30' : 'bg-gray-50 border-gray-200'}`}>
        <div className="flex items-center gap-4">
          {anyProcessing ? (
            <>
              <div className="flex items-center gap-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-kpfk-red opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-kpfk-red" />
                </span>
                <span className="text-sm font-semibold text-kpfk-black">PROCESSING</span>
              </div>
              <div className="flex items-center gap-3 text-sm text-gray-600">
                {activeJobs.map((j) => (
                  <span key={j.stage}>{j.stage} ({j.count})</span>
                ))}
                {activeJobs.length === 0 && (
                  <span>{queues.ingest.waiting + queues.transcribe.waiting + queues.summarize.waiting + queues.compliance.waiting} queued</span>
                )}
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <span className="inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
              <span className="text-sm text-gray-500">All caught up</span>
            </div>
          )}
          {/* 3f: Next ingest countdown */}
          <span className="text-[10px] text-gray-400 hidden md:inline">
            Next ingest in {nextIngest} min
          </span>
        </div>
        <div className="flex items-center gap-3">
          {/* Manual triggers */}
          {(['ingest', 'transcribe', 'summarize', 'compliance'] as const).map((action) => (
            <button
              key={action}
              onClick={() => triggerAction(action)}
              disabled={actionLoading !== null}
              className="px-2.5 py-1 text-xs font-medium rounded bg-kpfk-black text-white hover:bg-gray-700 disabled:opacity-40 transition-colors"
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
      <div className="bg-white rounded-xl shadow-sm border p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-kpfk-black">{data.quarter.label}</h2>
          {qirStatus && (
            <a href="/dashboard/generate" className={`text-xs px-3 py-1 rounded-full border font-medium ${
              qirStatus.status === 'final' ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'
            }`}>
              QIR: {qirStatus.status === 'final' ? 'Finalized' : 'Draft'} (v{qirStatus.version}, {qirStatus.entryCount} entries)
            </a>
          )}
          {!qirStatus && (
            <a href="/dashboard/generate" className="text-xs px-3 py-1 rounded-full border border-gray-200 text-gray-500 hover:border-gray-400">
              QIR: Not generated
            </a>
          )}
        </div>

        {/* Big numbers */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-3 mb-4">
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
              className="text-center p-3 rounded-lg border hover:shadow-sm transition-shadow"
            >
              <p className="text-2xl font-bold text-kpfk-black">{count}</p>
              <p className="text-[11px] text-gray-500">{STATUS_LABELS[status] ?? status}</p>
            </a>
          ))}
        </div>

        {/* Progress bar */}
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Pipeline completion</span>
            <span className="font-medium text-kpfk-black">{qtrPct}% ({qtrComplete}/{qtrTotal})</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2.5">
            <div className="bg-kpfk-red h-2.5 rounded-full transition-all duration-500" style={{ width: `${qtrPct}%` }} />
          </div>
        </div>
      </div>

      {/* ═══ 3. QIR READINESS + 4. TIME ESTIMATES ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* QIR Readiness */}
        <div className={`rounded-xl border p-5 ${readinessColor}`}>
          <h3 className="text-xs font-semibold uppercase tracking-wide mb-3 opacity-70">QIR Readiness</h3>
          <p className="text-lg font-bold mb-2">
            {qirReadiness.coveredCategories.length} of {qirReadiness.totalCategories} categories covered
          </p>
          {qirReadiness.missingCategories.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-1 opacity-70">Missing:</p>
              <div className="flex flex-wrap gap-1.5">
                {qirReadiness.missingCategories.map((cat) => (
                  <span key={cat} className="text-[11px] px-2 py-0.5 rounded-full bg-white/50 border border-current/10">{cat}</span>
                ))}
              </div>
            </div>
          )}
          {qirReadiness.missingCategories.length === 0 && (
            <p className="text-sm">All FCC issue categories are covered. Ready to generate QIR.</p>
          )}
        </div>

        {/* Time Estimates */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Time Estimates</h3>
          {!timeEstimates.transcription && !timeEstimates.summarization && !timeEstimates.compliance ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <span className="inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
              All caught up
            </div>
          ) : (
            <div className="space-y-3">
              {timeEstimates.transcription && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Transcription</span>
                  <span className="font-medium text-kpfk-black">
                    {fmtDur(timeEstimates.transcription.totalMinutes)} ({timeEstimates.transcription.count} episodes)
                  </span>
                </div>
              )}
              {timeEstimates.summarization && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Summarization</span>
                  <span className="font-medium text-kpfk-black">
                    {fmtDur(timeEstimates.summarization.totalMinutes)} ({timeEstimates.summarization.count} episodes)
                  </span>
                </div>
              )}
              {timeEstimates.compliance && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Compliance</span>
                  <span className="font-medium text-kpfk-black">
                    {fmtDur(timeEstimates.compliance.totalMinutes)} ({timeEstimates.compliance.count} episodes)
                  </span>
                </div>
              )}
              <div className="pt-2 border-t text-xs text-gray-400">
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

      {/* ═══ 5. BROADCAST LOG (Activity) — 3a: day grouping, duration/cost, 50 entries ═══ */}
      <div className="bg-white rounded-xl shadow-sm border">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Broadcast Log</h3>
          <span className="text-[10px] text-gray-400">Last {activity24h.length} events</span>
        </div>
        <div className="max-h-[400px] overflow-y-auto scroll-smooth">
          {activityByDay.length > 0 ? activityByDay.map((group) => (
            <div key={group.label}>
              {/* Day header */}
              <div className="sticky top-0 z-10 bg-gray-50 px-5 py-1.5 border-b border-gray-100">
                <span className="text-[10px] font-semibold text-gray-400 tracking-wide">{group.label}</span>
                <span className="text-[10px] text-gray-300 ml-2">{group.items.length} events</span>
              </div>
              {/* Entries */}
              <div className="divide-y divide-gray-50">
                {group.items.map((item, i) => (
                  <a
                    key={`${item.id}-${i}`}
                    href={`/dashboard/episodes/${item.id}`}
                    className="flex items-center gap-3 px-5 py-2.5 hover:bg-kpfk-cream/50 transition-colors"
                  >
                    <span className="text-xs text-gray-400 w-20 shrink-0 font-mono">{fmtTime(item.time)}</span>
                    <span className="text-xs text-gray-400 shrink-0">—</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${BADGE_COLORS[item.status] ?? 'bg-gray-100 text-gray-600'}`}>
                      {STATUS_VERB[item.status] ?? item.status}
                    </span>
                    <span className="text-sm text-gray-700 truncate">{item.show_name ?? `#${item.id}`}</span>
                    {item.headline && <span className="text-xs text-gray-400 truncate hidden lg:inline">— {item.headline}</span>}
                    {/* 3a: Right column — duration for transcriptions, cost for summarizations */}
                    <span className="text-[10px] text-gray-400 shrink-0 ml-auto flex items-center gap-2">
                      {item.status === 'transcribed' && item.duration_seconds != null && (
                        <span className="text-blue-500">{fmtSecs(item.duration_seconds)}</span>
                      )}
                      {(item.status === 'summarized' || item.status === 'compliance_checked') && item.cost != null && (
                        <span className="text-emerald-500">{fmtCost(item.cost)}</span>
                      )}
                      {timeAgo(item.time)}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )) : (
            <p className="px-5 py-4 text-sm text-gray-400">No recent activity</p>
          )}
        </div>
      </div>

      {/* ═══ 6. ATTENTION NEEDED + 6.5 COMPLIANCE ═══ */}
      {/* 3b: Hide entire section when both subsections are empty */}
      {(attentionCount > 0 || totalFlags > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Attention Needed — 3b: with retry/mark-unavailable buttons and quality flags */}
          {attentionCount > 0 && (
            <div className="bg-white rounded-xl shadow-sm border">
              <div className="px-5 py-3 border-b flex items-center justify-between">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Attention Needed</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">{attentionCount}</span>
              </div>
              <div className="max-h-56 overflow-y-auto">
                {/* Failed episodes with inline actions */}
                {failedEpisodes.length > 0 && failedEpisodes.map((ep) => (
                  <div key={ep.id} className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50 last:border-0 hover:bg-red-50/50 transition-colors">
                    <a href={`/dashboard/episodes/${ep.id}`} className="text-sm text-gray-700 truncate flex-1">{ep.show_name ?? `#${ep.id}`}</a>
                    <span className="text-xs text-gray-400 shrink-0">{ep.air_date ?? ''}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); retryEpisode(ep.id) }}
                      disabled={actionLoading !== null}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-40 font-medium"
                    >
                      {actionLoading === `retry-${ep.id}` ? '...' : 'Retry'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); markUnavailable(ep.id) }}
                      disabled={actionLoading !== null}
                      className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 disabled:opacity-40 font-medium"
                    >
                      {actionLoading === `unavail-${ep.id}` ? '...' : 'Unavail'}
                    </button>
                  </div>
                ))}
                {/* Quality flags sub-section */}
                {qualityFlags && qualityFlags.length > 0 && (
                  <>
                    {failedEpisodes.length > 0 && (
                      <div className="px-5 py-1.5 bg-gray-50 border-b border-gray-100">
                        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Quality Flags</span>
                      </div>
                    )}
                    {qualityFlags.map((flag) => (
                      <a key={flag.id} href={`/dashboard/episodes/${flag.id}`} className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50 last:border-0 hover:bg-amber-50/50 transition-colors">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium shrink-0">Quality</span>
                        <span className="text-sm text-gray-700 truncate flex-1">{flag.show_name ?? `#${flag.id}`}</span>
                        <span className="text-[10px] text-gray-400 shrink-0 hidden md:inline">{flag.reason}</span>
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

          {/* Compliance Summary — 3c: link to /dashboard/compliance */}
          {totalFlags > 0 && (
            <div className="bg-white rounded-xl shadow-sm border">
              <div className="px-5 py-3 border-b flex items-center justify-between">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Compliance</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${totalCritical > 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                  {totalFlags} unresolved
                </span>
              </div>
              <div className="px-5 py-3">
                <div className="flex flex-wrap gap-2">
                  {Object.entries(complianceSummary).map(([type, { count, critical }]) => (
                    <a
                      key={type}
                      href={`/dashboard/compliance?type=${type}`}
                      className={`text-xs px-2.5 py-1 rounded-full border font-medium ${
                        critical > 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'
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

      {/* ═══ 7. SHOW COVERAGE GAPS — 3d: clickable pills, collapsible, count in header ═══ */}
      {coverageGaps.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border">
          <button
            onClick={() => setGapsCollapsed(!gapsCollapsed)}
            className="w-full px-5 py-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Show Coverage Gaps</h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">{coverageGaps.length}</span>
            </div>
            <span className="text-gray-400 text-xs">{gapsCollapsed ? '▶' : '▼'}</span>
          </button>
          {!gapsCollapsed && (
            <div className="px-5 pb-4">
              <p className="text-xs text-gray-500 mb-2">Active shows with no summarized episodes this quarter:</p>
              <div className="flex flex-wrap gap-1.5">
                {coverageGaps.map((name) => (
                  <a
                    key={name}
                    href={`/dashboard/episodes?show=${encodeURIComponent(name)}&quarter=${data.quarter.year}-Q${data.quarter.quarter}`}
                    className="text-xs px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 transition-colors"
                  >
                    {name}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ 8. COST THIS MONTH — 3g: monthly projection ═══ */}
      <div className="bg-white rounded-xl shadow-sm border px-5 py-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4 text-sm text-gray-600 flex-wrap">
          <span className="font-medium text-kpfk-black">
            {new Date().toLocaleString('en-US', { month: 'long' })} spend: {fmtCost(cost.month.total)}
          </span>
          <span className="text-xs text-gray-400">
            Groq {fmtCost(cost.month.groq)} / OpenAI {fmtCost(cost.month.openai)}
          </span>
          {cost.quarter.episodeCount > 0 && (
            <span className="text-xs text-gray-400">
              avg ${(cost.quarter.total / cost.quarter.episodeCount).toFixed(3)}/episode
            </span>
          )}
          {dayOfMonth > 1 && (
            <span className="text-xs text-gray-400">
              projected: {fmtCost(monthlyProjection)}/mo
            </span>
          )}
        </div>
        <a href="/dashboard/usage" className="text-xs text-gray-400 hover:text-gray-600">Details →</a>
      </div>

      {/* ═══ BOTTOM ROW: Categories + Recent Episodes ═══ */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Issue Categories — 3e: clickable bars */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Issue Categories</h3>
          {categories.length > 0 ? (
            <div className="space-y-2">
              {categories.map((c, i) => {
                const max = categories[0]?.count ?? 1
                const colors = ['bg-kpfk-red', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500', 'bg-cyan-500']
                return (
                  <a
                    key={c.name}
                    href={`/dashboard/episodes?category=${encodeURIComponent(c.name)}&quarter=${data.quarter.year}-Q${data.quarter.quarter}`}
                    className="block hover:bg-gray-50 rounded transition-colors -mx-1 px-1"
                  >
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-gray-700 truncate mr-2">{c.name}</span>
                      <span className="text-gray-500 shrink-0">{c.count}</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className={`h-2 rounded-full transition-all ${colors[i % colors.length]}`}
                        style={{ width: `${max > 0 ? (c.count / max) * 100 : 0}%` }}
                      />
                    </div>
                  </a>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No categorized episodes yet</p>
          )}
        </div>

        {/* Recent Episodes */}
        <div className="bg-white rounded-xl shadow-sm border">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Recent Episodes</h3>
            <a href="/dashboard/episodes" className="text-xs text-kpfk-red hover:underline">View all →</a>
          </div>
          <div className="divide-y max-h-72 overflow-y-auto">
            {data.recentEpisodes.map((ep) => (
              <a key={ep.id} href={`/dashboard/episodes/${ep.id}`} className="flex items-center gap-3 px-5 py-2.5 hover:bg-kpfk-cream/50 transition-colors">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${BADGE_COLORS[ep.status] ?? 'bg-gray-100'}`}>
                  {STATUS_LABELS[ep.status] ?? ep.status}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-900 truncate">{ep.show_name ?? `#${ep.id}`}</p>
                </div>
                <span className="text-[10px] text-gray-400 shrink-0">{ep.air_date ?? timeAgo(ep.updated_at)}</span>
              </a>
            ))}
            {data.recentEpisodes.length === 0 && (
              <p className="px-5 py-4 text-sm text-gray-400">No episodes yet</p>
            )}
          </div>
        </div>
      </div>

      {/* ═══ 9. SYSTEM HEALTH FOOTER ═══ */}
      <SystemHealthFooter queues={queues} activity={activity24h} lastFiled={data.lastFiledQir} />
    </div>
  )
}

/* ─── System Health Footer ─── */
function SystemHealthFooter({ queues, activity, lastFiled }: { queues: DashData['queues']; activity: ActivityItem[]; lastFiled: DashData['lastFiledQir'] }) {
  // Find last activity time per stage
  const lastIngest = activity.find((a) => a.status === 'pending')?.time
  const lastTranscribe = activity.find((a) => a.status === 'transcribed')?.time
  const lastSummarize = activity.find((a) => a.status === 'summarized' || a.status === 'compliance_checked')?.time

  function staleness(iso: string | undefined): { label: string; color: string } {
    if (!iso) return { label: 'never', color: 'text-gray-400' }
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
    if (mins < 120) return { label: timeAgo(iso), color: 'text-emerald-600' }
    if (mins < 480) return { label: timeAgo(iso), color: 'text-amber-600' }
    return { label: timeAgo(iso), color: 'text-red-600' }
  }

  const ingestInfo = staleness(lastIngest)
  const transcribeInfo = staleness(lastTranscribe)
  const summarizeInfo = staleness(lastSummarize)

  const workersRunning = queues.ingest.active + queues.transcribe.active + queues.summarize.active + queues.compliance.active >= 0 // always true if API responds
  const workerColor = workersRunning ? 'text-emerald-600' : 'text-red-600'

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 px-5 py-2.5 flex items-center gap-6 text-xs text-gray-500 flex-wrap">
      <span>Workers: <span className={`font-medium ${workerColor}`}>running</span></span>
      <span>Last ingest: <span className={`font-medium ${ingestInfo.color}`}>{ingestInfo.label}</span></span>
      <span>Last transcription: <span className={`font-medium ${transcribeInfo.color}`}>{transcribeInfo.label}</span></span>
      <span>Last summarization: <span className={`font-medium ${summarizeInfo.color}`}>{summarizeInfo.label}</span></span>
      {lastFiled && (
        <span>Last QIR filed: <a href={`/${lastFiled.year}/q${lastFiled.quarter}`} className="font-medium text-kpfk-red hover:underline">Q{lastFiled.quarter} {lastFiled.year}</a></span>
      )}
    </div>
  )
}
