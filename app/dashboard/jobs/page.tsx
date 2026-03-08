'use client'

import { useState, useEffect, useCallback } from 'react'
import { SkeletonCard } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { useQueueSSE } from '@/lib/use-sse'

interface FailedJob {
  id: string
  name: string
  data: Record<string, unknown>
  failedReason: string
  timestamp: number
  finishedOn: number
}

interface QueueWithFailed {
  active: number
  waiting: number
  completed: number
  failed: number
  failedJobs: FailedJob[]
}

type PipelineMode = 'steady' | 'catch-up'

const queueNames = ['ingest', 'transcribe', 'summarize', 'compliance'] as const

export default function JobsPage() {
  const queues = useQueueSSE()
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>('steady')
  const [failedDetails, setFailedDetails] = useState<Record<string, QueueWithFailed> | null>(null)
  const [failedExpanded, setFailedExpanded] = useState(false)
  const [confirmClear, setConfirmClear] = useState<string | null>(null)
  const [sseTimedOut, setSseTimedOut] = useState(false)
  const { toast } = useToast()

  const anyLoading = actionLoading !== null

  // Fetch failed job details and pipeline mode setting
  const fetchDetails = useCallback(async () => {
    try {
      const [jobsRes, settingsRes] = await Promise.all([
        fetch('/api/jobs'),
        fetch('/api/settings'),
      ])
      if (jobsRes.ok) {
        const data = await jobsRes.json()
        setFailedDetails(data)
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        const mode = data.settings?.pipeline_mode
        if (mode) {
          try {
            const parsed = JSON.parse(mode)
            if (parsed === 'steady' || parsed === 'catch-up') {
              setPipelineMode(parsed)
            }
          } catch {
            // Use default
          }
        }
      }
    } catch {
      // Silently fail — SSE provides live counts
    }
  }, [])

  useEffect(() => {
    fetchDetails()
    const interval = setInterval(fetchDetails, 15000)
    return () => clearInterval(interval)
  }, [fetchDetails])

  // SSE timeout fallback — if no data after 15 seconds, show error state
  useEffect(() => {
    if (queues) {
      setSseTimedOut(false)
      return
    }
    const timeout = setTimeout(() => setSseTimedOut(true), 15000)
    return () => clearTimeout(timeout)
  }, [queues])

  async function triggerJob(action: string) {
    setActionLoading(action)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (res.ok) {
        toast('success', `${action} job queued`)
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? `Failed to queue ${action}`)
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setActionLoading(null)
  }

  async function togglePipelineMode() {
    const newMode: PipelineMode = pipelineMode === 'steady' ? 'catch-up' : 'steady'
    setActionLoading('pipeline-mode')
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_pipeline_mode', mode: newMode }),
      })
      if (res.ok) {
        setPipelineMode(newMode)
        toast('success', `Pipeline mode set to ${newMode}`)
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to change pipeline mode')
      }
    } catch {
      toast('error', 'Network error')
    }
    setActionLoading(null)
  }

  async function clearFailed(queueName: string) {
    setActionLoading(`clear-${queueName}`)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear_failed', queue: queueName }),
      })
      if (res.ok) {
        toast('success', `Cleared failed jobs from ${queueName}`)
        await fetchDetails()
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to clear')
      }
    } catch {
      toast('error', 'Network error')
    }
    setActionLoading(null)
  }

  async function retryFailed(queueName: string) {
    setActionLoading(`retry-${queueName}`)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry_failed', queue: queueName }),
      })
      if (res.ok) {
        const data = await res.json()
        toast('success', data.message)
        await fetchDetails()
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to retry')
      }
    } catch {
      toast('error', 'Network error')
    }
    setActionLoading(null)
  }

  // SSE timed out — show error with fallback data from polling
  if (sseTimedOut && !queues) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Jobs</h2>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <p className="text-sm text-amber-800">
            Unable to connect to live updates. Queue data may be stale.
          </p>
          <button
            onClick={() => { setSseTimedOut(false); window.location.reload() }}
            className="mt-2 px-3 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200 transition-colors"
          >
            Retry Connection
          </button>
        </div>
        {failedDetails && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {queueNames.map((name) => {
              const q = failedDetails[name] ?? { active: 0, waiting: 0, completed: 0, failed: 0 }
              return (
                <div key={name} className="bg-white rounded-xl shadow-sm border p-4 space-y-3 opacity-75">
                  <h3 className="font-semibold capitalize">{name}</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <CountCell count={q.active} label="Active" bg="bg-blue-50" text="text-blue-700" sub="text-blue-600" />
                    <CountCell count={q.waiting} label="Waiting" bg="bg-yellow-50" text="text-yellow-700" sub="text-yellow-600" />
                    <CountCell count={q.completed} label="Completed" bg="bg-green-50" text="text-green-700" sub="text-green-600" />
                    <CountCell count={q.failed} label="Failed" bg={q.failed > 0 ? 'bg-red-50' : 'bg-gray-50'} text={q.failed > 0 ? 'text-red-700' : 'text-gray-500'} sub={q.failed > 0 ? 'text-red-600' : 'text-gray-400'} />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (!queues) return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Jobs</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  )

  // Use SSE counts for failed section visibility (more up-to-date than polling)
  const anyQueueHasFailed = queueNames.some((name) => {
    const sseCount = queues[name]?.failed ?? 0
    const polledCount = failedDetails?.[name]?.failedJobs?.length ?? 0
    return sseCount > 0 || polledCount > 0
  })

  const totalFailedJobs = queueNames.reduce((sum, name) => {
    return sum + (failedDetails?.[name]?.failedJobs?.length ?? 0)
  }, 0)

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Jobs</h2>

      {/* Queue Cards — 4 columns */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {queueNames.map((name) => {
          const q = queues[name] ?? { active: 0, waiting: 0, completed: 0, failed: 0 }
          return (
            <div key={name} className="bg-white rounded-xl shadow-sm border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold capitalize">{name}</h3>
                <button
                  onClick={() => triggerJob(name)}
                  disabled={anyLoading}
                  className="px-3 py-1 text-xs bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {actionLoading === name ? 'Queuing...' : 'Run Now'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <CountCell count={q.active} label="Active" bg="bg-blue-50" text="text-blue-700" sub="text-blue-600" />
                <CountCell count={q.waiting} label="Waiting" bg="bg-yellow-50" text="text-yellow-700" sub="text-yellow-600" />
                <CountCell count={q.completed} label="Completed" bg="bg-green-50" text="text-green-700" sub="text-green-600" />
                <CountCell count={q.failed} label="Failed" bg={q.failed > 0 ? 'bg-red-50' : 'bg-gray-50'} text={q.failed > 0 ? 'text-red-700' : 'text-gray-500'} sub={q.failed > 0 ? 'text-red-600' : 'text-gray-400'} />
              </div>
            </div>
          )
        })}
      </div>

      {/* Pipeline Mode Toggle */}
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Pipeline Mode</h3>
            <p className="text-sm text-gray-600 mt-1">
              {pipelineMode === 'steady'
                ? 'Steady: 1 transcribe / 5 summarize concurrent.'
                : 'Catch-up: 3 transcribe / 10 summarize concurrent.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium px-2 py-0.5 rounded ${
              pipelineMode === 'steady'
                ? 'bg-green-100 text-green-800'
                : 'bg-amber-100 text-amber-800'
            }`}>
              {pipelineMode === 'steady' ? 'Steady' : 'Catch-up'}
            </span>
            <button
              onClick={togglePipelineMode}
              disabled={anyLoading}
              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 transition-colors"
            >
              {actionLoading === 'pipeline-mode' ? 'Switching...' : `Switch to ${pipelineMode === 'steady' ? 'Catch-up' : 'Steady'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Cron Schedule Reference */}
      <div className="bg-white rounded-xl shadow-sm border p-4">
        <h3 className="font-semibold mb-3">Cron Schedule</h3>
        <div className="space-y-1.5 text-sm text-gray-600">
          <p>Ingest runs at minute :02 of every hour.</p>
          <p>Transcription triggers automatically after ingest finds new episodes.</p>
          <p>Summarization triggers after transcription completes.</p>
          <p>Compliance triggers after summarization completes.</p>
          <p>Auto-retry runs every 4 hours for failed episodes (max 3 retries).</p>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          Live updates via server-sent events.
        </p>
      </div>

      {/* Failed Jobs Detail — collapsible */}
      {anyQueueHasFailed && (
        <div className="bg-white rounded-xl shadow-sm border">
          <button
            onClick={() => setFailedExpanded(!failedExpanded)}
            className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">Failed Jobs</h3>
              <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                {totalFailedJobs > 0 ? totalFailedJobs : '...'}
              </span>
            </div>
            <svg
              className={`w-5 h-5 text-gray-400 transition-transform ${failedExpanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {failedExpanded && (
            <div className="border-t px-4 pb-4 space-y-4">
              {queueNames.map((name) => {
                const q = failedDetails?.[name]
                const jobs = q?.failedJobs ?? []
                if (jobs.length === 0) return null

                return (
                  <div key={name} className="pt-4 first:pt-2">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-sm font-semibold capitalize text-gray-700">
                        {name} <span className="text-red-500 font-normal">({jobs.length} failed)</span>
                      </h4>
                      <div className="flex gap-2">
                        <button
                          onClick={() => retryFailed(name)}
                          disabled={anyLoading}
                          className="px-2 py-1 text-xs bg-amber-100 text-amber-800 rounded hover:bg-amber-200 disabled:opacity-50 transition-colors"
                        >
                          {actionLoading === `retry-${name}` ? 'Retrying...' : 'Retry All Failed'}
                        </button>
                        <button
                          onClick={() => setConfirmClear(name)}
                          disabled={anyLoading}
                          className="px-2 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200 disabled:opacity-50 transition-colors"
                        >
                          {actionLoading === `clear-${name}` ? 'Clearing...' : 'Clear Failed'}
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1">
                      {jobs.map((job) => (
                        <div key={job.id} className="flex items-start gap-3 text-sm bg-red-50/50 rounded px-3 py-2">
                          <span className="text-gray-400 font-mono text-xs shrink-0 pt-0.5">
                            #{job.id}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-gray-700 truncate">
                              {job.name}
                              {job.data?.episodeId ? (
                                <span className="text-gray-400 ml-1">
                                  (episode {String(job.data.episodeId).slice(0, 8)})
                                </span>
                              ) : null}
                            </p>
                            <p className="text-red-600 text-xs truncate mt-0.5">
                              {job.failedReason || 'Unknown error'}
                            </p>
                            {job.finishedOn && (
                              <p className="text-gray-400 text-xs mt-0.5">
                                Failed {formatRelativeTime(job.finishedOn)}
                              </p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Confirm dialog for clearing failed jobs */}
      <ConfirmDialog
        open={confirmClear !== null}
        title="Clear Failed Jobs"
        message={`Permanently remove all failed jobs from the ${confirmClear} queue? This clears them from BullMQ but does not change episode statuses.`}
        confirmLabel="Clear Failed"
        confirmVariant="danger"
        onConfirm={() => {
          if (confirmClear) clearFailed(confirmClear)
          setConfirmClear(null)
        }}
        onCancel={() => setConfirmClear(null)}
      />
    </div>
  )
}

function CountCell({ count, label, bg, text, sub }: {
  count: number
  label: string
  bg: string
  text: string
  sub: string
}) {
  return (
    <div className={`${bg} rounded p-2 text-center`}>
      <p className={`text-lg font-bold ${text}`}>{count}</p>
      <p className={`text-xs ${sub}`}>{label}</p>
    </div>
  )
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
