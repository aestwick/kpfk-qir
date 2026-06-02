'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { authedFetch } from '@/lib/api-client'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { EmptyState } from '@/app/components/empty-state'

const QUEUES = ['ingest', 'transcribe', 'summarize', 'compliance'] as const
type QueueName = (typeof QUEUES)[number]

interface StationRow {
  id: string
  slug: string
  name: string
  paused: boolean
  effectivePaused: boolean
  episodes: { pending: number; transcribed: number; summarized: number; compliance_checked: number; failed: number; total: number }
  activity: { active: number; waiting: number; failed: number }
}

interface JobItem {
  queue: QueueName
  id: string
  name: string
  state: string
  stationId: string | null
  timestamp: number
  processedOn: number | null
  finishedOn: number | null
  failedReason?: string
  progress?: { current?: number; total?: number; showName?: string } | null
}

interface Overview {
  global: { paused: boolean; mode: string }
  queues: Record<QueueName, { active: number; waiting: number; completed: number; failed: number }>
  stations: StationRow[]
  jobs: { recent: JobItem[]; waiting: JobItem[] }
  quarter: { start: string; end: string }
}

function fmtTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const stateBadge: Record<string, string> = {
  active: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  waiting: 'bg-warm-200 text-warm-600 dark:bg-warm-700 dark:text-warm-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

export default function MasterControlPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const notify = useCallback((kind: 'ok' | 'err', msg: string) => {
    setFlash({ kind, msg })
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 4000)
  }, [])

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true)
    const res = await authedFetch('/api/admin/overview')
    if (res.status === 403) {
      setForbidden(true)
      setLoading(false)
      return
    }
    if (res.ok) {
      setData(await res.json())
      setForbidden(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load(true)
    const t = setInterval(() => load(false), 10_000)
    return () => clearInterval(t)
  }, [load])

  const act = useCallback(
    async (key: string, body: Record<string, unknown>) => {
      setBusy(key)
      try {
        const res = await authedFetch('/api/admin/overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          notify('err', json.error ?? 'Action failed')
          return
        }
        notify('ok', json.message ?? 'Done')
        await load(false)
      } catch {
        notify('err', 'Network error')
      } finally {
        setBusy(null)
      }
    },
    [load, notify]
  )

  if (forbidden) {
    return (
      <div className="max-w-lg mx-auto mt-12">
        <EmptyState
          title="Access denied"
          description="Master control is restricted to super-admins. If you believe you should have access, contact a system administrator."
        />
      </div>
    )
  }

  const g = data?.global
  const stations = data?.stations ?? []
  const stationName = (id: string | null) => stations.find((s) => s.id === id)?.slug ?? (id ? id.slice(0, 8) : 'all')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">Master Control</h2>
          <p className="text-sm text-warm-500 dark:text-warm-400">All stations — pipeline activity and controls (super-admin)</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-warm-400">Mode: <span className="font-medium text-warm-600 dark:text-warm-300">{g?.mode ?? '—'}</span></span>
          {g?.paused ? (
            <button
              onClick={() => act('resume_all', { action: 'resume_all' })}
              disabled={busy !== null}
              className="px-4 py-2.5 text-sm font-semibold bg-emerald-100 text-emerald-700 border border-emerald-300 rounded-lg hover:bg-emerald-200 disabled:opacity-50 transition-colors"
            >
              {busy === 'resume_all' ? '...' : 'Resume All'}
            </button>
          ) : (
            <button
              onClick={() => act('pause_all', { action: 'pause_all' })}
              disabled={busy !== null}
              className="px-4 py-2.5 text-sm font-semibold bg-red-100 text-red-700 border border-red-300 rounded-lg hover:bg-red-200 disabled:opacity-50 transition-colors"
            >
              {busy === 'pause_all' ? '...' : 'Pause All'}
            </button>
          )}
        </div>
      </div>

      {flash && (
        <div className={`rounded-lg px-4 py-2.5 text-sm font-medium ${flash.kind === 'ok' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800/40' : 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:border-red-800/40'}`}>
          {flash.msg}
        </div>
      )}

      {g?.paused && (
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800/40 px-5 py-3 flex items-center gap-2.5">
          <span className="inline-flex rounded-full h-3 w-3 bg-red-500" />
          <span className="text-sm font-semibold text-red-700 dark:text-red-300">Global pause is on</span>
          <span className="text-xs text-red-500 dark:text-red-400">Every station is paused regardless of its own setting.</span>
        </div>
      )}

      {/* Queue totals (across all stations) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {QUEUES.map((name) => {
          const q = data?.queues?.[name] ?? { active: 0, waiting: 0, completed: 0, failed: 0 }
          return (
            <div key={name} className="bg-gray-50 dark:bg-warm-800/50 rounded-lg p-4 border border-transparent" data-working={q.active > 0}>
              <div className="flex items-center justify-between">
                <h3 className="font-semibold capitalize">{name}</h3>
                {q.active > 0 && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />}
              </div>
              <div className="mt-2 flex gap-3 text-xs">
                <span className="text-blue-600 dark:text-blue-300">{q.active} active</span>
                <span className="text-warm-500">{q.waiting} queued</span>
                <span className="text-red-600 dark:text-red-400">{q.failed} failed</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Per-station table */}
      <div className="bg-white dark:bg-warm-900 rounded-xl border border-warm-200 dark:border-warm-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-warm-200 dark:border-warm-700">
          <h3 className="font-semibold">Stations</h3>
          {data && <p className="text-xs text-warm-400">Episode counts for the current quarter ({data.quarter.start} → {data.quarter.end})</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-warm-400 dark:text-warm-500 text-xs border-b border-warm-100 dark:border-warm-800">
                <th className="font-medium px-5 py-2">Station</th>
                <th className="font-medium px-2 py-2">Status</th>
                <th className="font-medium px-2 py-2">In&nbsp;flight</th>
                <th className="font-medium px-2 py-2">Pending</th>
                <th className="font-medium px-2 py-2">Transcribed</th>
                <th className="font-medium px-2 py-2">Summarized</th>
                <th className="font-medium px-2 py-2">Checked</th>
                <th className="font-medium px-2 py-2">Failed</th>
                <th className="font-medium px-5 py-2 text-right">Controls</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data ? (
                <SkeletonTableRows rows={4} />
              ) : stations.length === 0 ? (
                <tr><td colSpan={9} className="px-5 py-6 text-center text-warm-400">No stations.</td></tr>
              ) : (
                stations.map((s) => {
                  const a = s.activity
                  const inFlight = a.active + a.waiting
                  return (
                    <tr key={s.id} className="border-b border-warm-100 dark:border-warm-800 last:border-0">
                      <td className="px-5 py-3">
                        <div className="font-medium">{s.name}</div>
                        <div className="text-xs text-warm-400">{s.slug}</div>
                      </td>
                      <td className="px-2 py-3">
                        {s.effectivePaused ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                            <span className="w-2 h-2 rounded-full bg-red-500" />
                            Paused{!s.paused && s.effectivePaused ? ' (global)' : ''}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <span className={`w-2 h-2 rounded-full bg-emerald-500 ${a.active > 0 ? 'animate-pulse' : ''}`} />
                            Running
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <span className={inFlight > 0 ? 'text-blue-600 dark:text-blue-300 font-medium' : 'text-warm-400'}>{inFlight}</span>
                        {a.failed > 0 && <span className="text-red-500 text-xs ml-1">({a.failed} failed)</span>}
                      </td>
                      <td className="px-2 py-3 tabular-nums">{s.episodes.pending}</td>
                      <td className="px-2 py-3 tabular-nums">{s.episodes.transcribed}</td>
                      <td className="px-2 py-3 tabular-nums">{s.episodes.summarized}</td>
                      <td className="px-2 py-3 tabular-nums">{s.episodes.compliance_checked}</td>
                      <td className="px-2 py-3 tabular-nums">
                        <span className={s.episodes.failed > 0 ? 'text-red-600 dark:text-red-400 font-medium' : ''}>{s.episodes.failed}</span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1.5 flex-wrap">
                          {s.paused ? (
                            <button
                              onClick={() => act(`resume:${s.id}`, { action: 'resume_station', stationId: s.id })}
                              disabled={busy !== null}
                              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-emerald-100 text-emerald-700 border border-emerald-300 hover:bg-emerald-200 disabled:opacity-50 transition-colors"
                            >
                              {busy === `resume:${s.id}` ? '...' : 'Resume'}
                            </button>
                          ) : (
                            <button
                              onClick={() => act(`pause:${s.id}`, { action: 'pause_station', stationId: s.id })}
                              disabled={busy !== null || g?.paused}
                              title={g?.paused ? 'Global pause is on' : ''}
                              className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-red-100 text-red-700 border border-red-300 hover:bg-red-200 disabled:opacity-50 transition-colors"
                            >
                              {busy === `pause:${s.id}` ? '...' : 'Pause'}
                            </button>
                          )}
                          <button
                            onClick={() => act(`advance:${s.id}`, { action: 'advance', stationId: s.id })}
                            disabled={busy !== null || s.effectivePaused}
                            title={s.effectivePaused ? 'Station is paused' : 'Ingest + advance pipeline'}
                            className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                          >
                            {busy === `advance:${s.id}` ? '...' : 'Run now'}
                          </button>
                          {a.failed > 0 && (
                            <>
                              <button
                                onClick={() => act(`retry:${s.id}`, { action: 'retry_failed', queue: 'transcribe', stationId: s.id })}
                                disabled={busy !== null}
                                title="Retry failed transcribe jobs for this station"
                                className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-amber-100 text-amber-700 border border-amber-300 hover:bg-amber-200 disabled:opacity-50 transition-colors"
                              >
                                Retry
                              </button>
                              <button
                                onClick={() => act(`clear:${s.id}`, { action: 'clear_failed', queue: 'transcribe', stationId: s.id })}
                                disabled={busy !== null}
                                title="Clear failed transcribe jobs for this station"
                                className="text-xs font-medium px-2.5 py-1.5 rounded-md bg-warm-100 text-warm-600 border border-warm-300 hover:bg-warm-200 dark:bg-warm-800 dark:text-warm-300 dark:border-warm-700 disabled:opacity-50 transition-colors"
                              >
                                Clear
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Activity feed — jobs across all stations */}
      <div className="bg-white dark:bg-warm-900 rounded-xl border border-warm-200 dark:border-warm-700 overflow-hidden">
        <div className="px-5 py-3 border-b border-warm-200 dark:border-warm-700">
          <h3 className="font-semibold">Recent activity</h3>
          <p className="text-xs text-warm-400">Job-level events across every station</p>
        </div>
        <div className="divide-y divide-warm-100 dark:divide-warm-800 max-h-96 overflow-y-auto">
          {(data?.jobs.recent.length ?? 0) === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-warm-400">No recent jobs.</div>
          ) : (
            data?.jobs.recent.map((j) => (
              <div key={`${j.queue}-${j.id}`} className="px-5 py-2.5 flex items-center gap-3 text-sm">
                <span className={`inline-flex px-1.5 py-0.5 rounded text-2xs font-medium ${stateBadge[j.state] ?? 'bg-warm-100 text-warm-500'}`}>{j.state}</span>
                <span className="font-medium capitalize w-24 shrink-0">{j.queue}</span>
                <span className="text-warm-500 dark:text-warm-400 w-20 shrink-0">{stationName(j.stationId)}</span>
                <span className="text-warm-400 truncate flex-1">
                  {j.progress?.showName ? j.progress.showName : j.name}
                  {j.failedReason ? <span className="text-red-500"> — {j.failedReason}</span> : ''}
                </span>
                <span className="text-xs text-warm-400 tabular-nums shrink-0">{fmtTime(j.finishedOn ?? j.processedOn ?? j.timestamp)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
