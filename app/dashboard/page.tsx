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
interface ActivityItem { id: number; show_name: string | null; status: string; time: string }
interface DashData {
  quarter: { year: number; quarter: number; start: string; end: string; label: string }
  counts: {
    all: Record<string, number>
    quarter: Record<string, number>
  }
  queues: { ingest: JobCounts; transcribe: JobCounts; summarize: JobCounts }
  cost: {
    quarter: { groq: number; openai: number; total: number; episodeCount: number; apiCalls: number }
    daily: DailyPoint[]
  }
  categories: CategoryItem[]
  shows: ShowItem[]
  recentEpisodes: RecentEp[]
  activity24h: ActivityItem[]
  avgProcessingTimes: Record<string, number>
}

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  pending:      { color: 'text-amber-700',  bg: 'bg-amber-50  border-amber-200', label: 'Pending' },
  transcribed:  { color: 'text-blue-700',   bg: 'bg-blue-50   border-blue-200',  label: 'Transcribed' },
  summarized:   { color: 'text-emerald-700',bg: 'bg-emerald-50 border-emerald-200', label: 'Summarized' },
  failed:       { color: 'text-red-700',    bg: 'bg-red-50    border-red-200',   label: 'Failed' },
  unavailable:  { color: 'text-gray-500',   bg: 'bg-gray-50   border-gray-200',  label: 'Unavailable' },
}

const PIPELINE_STAGES = [
  { key: 'ingest',     label: 'Ingest',     icon: '📡', desc: 'RSS → Episodes' },
  { key: 'transcribe', label: 'Transcribe', icon: '🎙️', desc: 'Audio → Text' },
  { key: 'summarize',  label: 'Summarize',  icon: '🧠', desc: 'Text → Insights' },
] as const

const BADGE_COLORS: Record<string, string> = {
  pending:     'bg-amber-100 text-amber-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized:  'bg-emerald-100 text-emerald-800',
  failed:      'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

/* ─── helpers ─── */
function fmt$(n: number) { return '$' + n.toFixed(4) }
function fmtCost(n: number) { return '$' + n.toFixed(2) }
function fmtDur(s: number) { return s < 60 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m` }
function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/* ─── mini bar chart (pure CSS) ─── */
function MiniBar({ data, maxHeight = 48 }: { data: DailyPoint[]; maxHeight?: number }) {
  if (data.length === 0) return <div className="text-xs text-gray-400">No cost data yet</div>
  const max = Math.max(...data.map(d => d.total), 0.001)
  return (
    <div className="flex items-end gap-px" style={{ height: maxHeight }}>
      {data.map((d) => {
        const groqH = (d.groq / max) * maxHeight
        const openaiH = (d.openai / max) * maxHeight
        return (
          <div key={d.date} className="flex-1 flex flex-col justify-end group relative min-w-[3px]">
            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 bg-gray-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap shadow-lg">
              {d.date}: {fmt$(d.total)}
            </div>
            <div className="bg-sky-400 rounded-t-sm" style={{ height: Math.max(groqH, 0.5) }} />
            <div className="bg-violet-400" style={{ height: Math.max(openaiH, 0.5) }} />
          </div>
        )
      })}
    </div>
  )
}

/* ─── horizontal bar chart ─── */
function HorizontalBars({ items, colorFn }: { items: { label: string; value: number; max: number }[]; colorFn?: (i: number) => string }) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-0.5">
            <span className="text-gray-700 truncate mr-2">{item.label}</span>
            <span className="text-gray-500 shrink-0">{item.value}</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${colorFn ? colorFn(i) : 'bg-emerald-500'}`}
              style={{ width: `${item.max > 0 ? (item.value / item.max) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─── pipeline visualization ─── */
function PipelineViz({ queues }: { queues: DashData['queues'] }) {
  return (
    <div className="flex items-stretch gap-0">
      {PIPELINE_STAGES.map((stage, i) => {
        const q = queues[stage.key]
        const isActive = q.active > 0
        const hasWaiting = q.waiting > 0
        return (
          <div key={stage.key} className="flex items-center flex-1">
            <div className={`
              flex-1 rounded-lg border-2 p-4 transition-all relative
              ${isActive
                ? 'border-blue-400 bg-blue-50 shadow-md shadow-blue-100'
                : hasWaiting
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-gray-200 bg-white'}
            `}>
              {isActive && (
                <div className="absolute top-2 right-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
                </div>
              )}
              <div className="text-xl mb-1">{stage.icon}</div>
              <div className="font-semibold text-sm">{stage.label}</div>
              <div className="text-[11px] text-gray-500 mb-2">{stage.desc}</div>
              <div className="flex gap-2 text-[11px]">
                {isActive && (
                  <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">
                    {q.active} active
                  </span>
                )}
                {hasWaiting && (
                  <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">
                    {q.waiting} queued
                  </span>
                )}
                {!isActive && !hasWaiting && (
                  <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">idle</span>
                )}
              </div>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className="px-1.5 text-gray-300 text-lg shrink-0">→</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ─── donut chart (SVG) ─── */
function DonutChart({ segments, size = 120 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) return <div className="text-xs text-gray-400 text-center py-4">No data</div>
  const r = (size / 2) - 8
  const circumference = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.filter(s => s.value > 0).map((seg) => {
          const pct = seg.value / total
          const dashLen = pct * circumference
          const dashOffset = -offset * circumference
          offset += pct
          return (
            <circle
              key={seg.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={14}
              strokeDasharray={`${dashLen} ${circumference - dashLen}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
        })}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" className="fill-gray-900 text-lg font-bold">{total}</text>
        <text x={size / 2} y={size / 2 + 12} textAnchor="middle" className="fill-gray-500 text-[10px]">episodes</text>
      </svg>
      <div className="space-y-1.5">
        {segments.filter(s => s.value > 0).map((seg) => (
          <div key={seg.label} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-gray-600">{seg.label}</span>
            <span className="font-medium text-gray-900">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── main dashboard ─── */
export default function DashboardOverview() {
  const [data, setData] = useState<DashData | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
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

  // Poll every 5s
  useEffect(() => {
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [fetchData])

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

  if (loading) return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>
      <SkeletonCards count={3} />
      <SkeletonBlock />
      <SkeletonCards count={4} />
      <SkeletonBlock />
    </div>
  )

  if (!data) return <div className="text-red-600">Failed to load dashboard data.</div>

  const { counts, queues, cost, categories, shows, recentEpisodes, activity24h, avgProcessingTimes } = data
  const qtrTotal = Object.values(counts.quarter).reduce((a, b) => a + b, 0)
  const qtrSummarized = counts.quarter.summarized ?? 0
  const qtrPct = qtrTotal > 0 ? Math.round((qtrSummarized / qtrTotal) * 100) : 0

  const anyActive = queues.ingest.active + queues.transcribe.active + queues.summarize.active > 0
  const anyWaiting = queues.ingest.waiting + queues.transcribe.waiting + queues.summarize.waiting > 0

  const donutSegments = [
    { label: 'Summarized', value: counts.quarter.summarized ?? 0, color: '#10b981' },
    { label: 'Transcribed', value: counts.quarter.transcribed ?? 0, color: '#3b82f6' },
    { label: 'Pending', value: counts.quarter.pending ?? 0, color: '#f59e0b' },
    { label: 'Failed', value: counts.quarter.failed ?? 0, color: '#ef4444' },
    { label: 'Unavailable', value: counts.quarter.unavailable ?? 0, color: '#9ca3af' },
  ]

  return (
    <div className="space-y-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Dashboard</h2>
          <p className="text-sm text-gray-500">{data.quarter.label} — FCC Compliance Pipeline</p>
        </div>
        <div className="flex items-center gap-2">
          {(anyActive || anyWaiting) && (
            <span className="flex items-center gap-1.5 text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded-full px-3 py-1">
              <span className="h-2 w-2 rounded-full bg-blue-500 animate-pulse" />
              Processing
            </span>
          )}
        </div>
      </div>

      {/* Pipeline Visualization */}
      <div className="bg-white rounded-xl shadow-sm border p-5">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">Pipeline Status</h3>
        <PipelineViz queues={queues} />

        {/* Quick actions */}
        <div className="mt-4 pt-4 border-t flex items-center gap-3">
          <span className="text-xs text-gray-400 uppercase font-semibold mr-1">Run:</span>
          {PIPELINE_STAGES.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => triggerAction(key)}
              disabled={actionLoading !== null}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            >
              {actionLoading === key && <span className="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full" />}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {Object.entries(counts.quarter).map(([status, count]) => {
          const cfg = STATUS_CONFIG[status] ?? { color: 'text-gray-700', bg: 'bg-gray-50 border-gray-200', label: status }
          return (
            <div key={status} className={`rounded-lg border p-3 ${cfg.bg}`}>
              <p className={`text-xs font-medium ${cfg.color} opacity-80`}>{cfg.label}</p>
              <p className={`text-2xl font-bold ${cfg.color}`}>{count}</p>
              <p className="text-[10px] text-gray-400 mt-0.5">
                {counts.all[status] ?? 0} all-time
              </p>
            </div>
          )
        })}
      </div>

      {/* Quarter progress + Donut + Cost */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Quarter Progress */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{data.quarter.label} Progress</h3>
          <DonutChart segments={donutSegments} />
          <div className="mt-4">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Completion</span>
              <span className="font-medium text-gray-900">{qtrPct}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2.5">
              <div className="bg-emerald-500 h-2.5 rounded-full transition-all" style={{ width: `${qtrPct}%` }} />
            </div>
            <p className="text-[11px] text-gray-400 mt-1">{qtrSummarized} of {qtrTotal} episodes fully processed</p>
          </div>
        </div>

        {/* Cost Analytics */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Cost This Quarter</h3>
          <div className="text-3xl font-bold text-gray-900">{fmtCost(cost.quarter.total)}</div>
          <div className="flex gap-4 mt-2 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm bg-sky-400" />
              <span className="text-gray-600">Groq</span>
              <span className="font-medium">{fmtCost(cost.quarter.groq)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm bg-violet-400" />
              <span className="text-gray-600">OpenAI</span>
              <span className="font-medium">{fmtCost(cost.quarter.openai)}</span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t">
            <p className="text-[10px] text-gray-400 uppercase font-semibold mb-2">Daily spend (30 days)</p>
            <MiniBar data={cost.daily} maxHeight={40} />
          </div>
          <div className="mt-3 pt-3 border-t grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-gray-400">Episodes</p>
              <p className="font-semibold text-gray-900">{cost.quarter.episodeCount}</p>
            </div>
            <div>
              <p className="text-gray-400">API Calls</p>
              <p className="font-semibold text-gray-900">{cost.quarter.apiCalls}</p>
            </div>
            <div>
              <p className="text-gray-400">Cost / Episode</p>
              <p className="font-semibold text-gray-900">{cost.quarter.episodeCount > 0 ? fmt$(cost.quarter.total / cost.quarter.episodeCount) : '—'}</p>
            </div>
          </div>
        </div>

        {/* Processing Times */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Avg Processing Time</h3>
          <div className="space-y-4">
            {Object.entries(avgProcessingTimes).length > 0 ? (
              Object.entries(avgProcessingTimes).map(([op, seconds]) => (
                <div key={op}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-gray-600 capitalize">{op}</span>
                    <span className="font-semibold text-gray-900">{fmtDur(seconds)}</span>
                  </div>
                  <div className="w-full bg-gray-100 rounded-full h-2">
                    <div
                      className={`h-2 rounded-full ${op === 'transcribe' ? 'bg-sky-500' : op === 'summarize' ? 'bg-violet-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min((seconds / Math.max(...Object.values(avgProcessingTimes))) * 100, 100)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-gray-400">No processing data yet</p>
            )}
          </div>

          {/* Throughput stats */}
          <div className="mt-4 pt-3 border-t">
            <h4 className="text-[10px] text-gray-400 uppercase font-semibold mb-2">Queue Totals</h4>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {PIPELINE_STAGES.map(({ key, label }) => {
                const q = queues[key]
                return (
                  <div key={key} className="text-center">
                    <p className="text-gray-400">{label}</p>
                    <p className="font-semibold text-gray-900">{q.completed}</p>
                    <p className="text-[10px] text-gray-400">completed</p>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom row: Categories + Shows + Activity */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Issue Categories */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Issue Categories</h3>
          {categories.length > 0 ? (
            <HorizontalBars
              items={categories.map(c => ({
                label: c.name,
                value: c.count,
                max: Math.max(...categories.map(x => x.count)),
              }))}
              colorFn={(i) => {
                const colors = ['bg-emerald-500', 'bg-blue-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500', 'bg-cyan-500']
                return colors[i % colors.length]
              }}
            />
          ) : (
            <p className="text-xs text-gray-400">No categorized episodes yet</p>
          )}
        </div>

        {/* Shows */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Shows This Quarter</h3>
          {shows.length > 0 ? (
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {shows.map((show) => (
                <div key={show.name} className="flex items-center justify-between text-xs py-1">
                  <span className="text-gray-700 truncate mr-2">{show.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-400">{show.summarized}/{show.total}</span>
                    <div className="w-12 bg-gray-100 rounded-full h-1.5">
                      <div
                        className="bg-emerald-500 h-1.5 rounded-full"
                        style={{ width: `${show.total > 0 ? (show.summarized / show.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No shows this quarter</p>
          )}
        </div>

        {/* 24h Activity Feed */}
        <div className="bg-white rounded-xl shadow-sm border p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Activity (24h)</h3>
          {activity24h.length > 0 ? (
            <div className="space-y-0 max-h-64 overflow-y-auto">
              {activity24h.slice(0, 20).map((item, i) => (
                <div key={`${item.id}-${i}`} className="flex items-center gap-2 py-1.5 border-b border-gray-50 last:border-0">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${BADGE_COLORS[item.status] ?? 'bg-gray-100 text-gray-600'}`}>
                    {item.status}
                  </span>
                  <span className="text-xs text-gray-700 truncate flex-1">{item.show_name ?? `#${item.id}`}</span>
                  <span className="text-[10px] text-gray-400 shrink-0">{timeAgo(item.time)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No activity in the last 24 hours</p>
          )}
        </div>
      </div>

      {/* Recent Episodes */}
      <div className="bg-white rounded-xl shadow-sm border">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Recent Episodes</h3>
          <a href="/dashboard/episodes" className="text-xs text-blue-600 hover:text-blue-800">View all →</a>
        </div>
        <div className="divide-y">
          {recentEpisodes.map((ep) => (
            <a key={ep.id} href={`/dashboard/episodes/${ep.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${BADGE_COLORS[ep.status] ?? 'bg-gray-100'}`}>
                {ep.status}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-gray-900 truncate">{ep.show_name ?? `Episode ${ep.id}`}</p>
                <p className="text-xs text-gray-500 truncate">{ep.headline ?? 'No headline'}</p>
              </div>
              <div className="text-right shrink-0">
                {ep.issue_category && (
                  <p className="text-[10px] text-gray-400">{ep.issue_category}</p>
                )}
                <p className="text-[10px] text-gray-400">{ep.air_date ?? timeAgo(ep.updated_at)}</p>
              </div>
            </a>
          ))}
          {recentEpisodes.length === 0 && (
            <p className="px-5 py-4 text-sm text-gray-400">No episodes yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
