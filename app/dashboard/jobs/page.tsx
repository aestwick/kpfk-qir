'use client'

import { useState, useEffect, useCallback } from 'react'
import { SkeletonCard } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { useQueueSSE, EpisodeBacklog, EpisodeCounts, ActiveJobInfo } from '@/lib/use-sse'

interface FailedJob {
  id: string
  name: string
  data: Record<string, unknown>
  failedReason: string
  timestamp: number
  finishedOn: number
}

interface JobDetail {
  id: string
  name: string
  data: Record<string, unknown>
  state: 'active' | 'waiting' | 'completed'
  timestamp: number
  processedOn: number | null
  finishedOn: number | null
  progress?: { current?: number; total?: number; episodeId?: number; showName?: string; airDate?: string } | null
  returnvalue?: Record<string, unknown> | null
}

interface QueueWithFailed {
  active: number
  waiting: number
  completed: number
  failed: number
  failedJobs: FailedJob[]
  jobs?: JobDetail[]
}

type PipelineMode = 'steady' | 'catch-up'

const queueNames = ['ingest', 'transcribe', 'summarize', 'compliance'] as const

const queueLabels: Record<typeof queueNames[number], string> = {
  ingest: 'Ingest',
  transcribe: 'Transcribe',
  summarize: 'Summarize',
  compliance: 'Generate QIR',
}

function getBacklogCount(name: typeof queueNames[number], backlog?: EpisodeBacklog | null): number | null {
  if (!backlog) return null
  switch (name) {
    case 'transcribe': return backlog.pendingTranscription
    case 'summarize': return backlog.pendingSummarization
    case 'compliance': return backlog.pendingCompliance
    default: return null
  }
}

function getEpisodeCompleted(name: typeof queueNames[number], counts?: EpisodeCounts | null): number | null {
  if (!counts) return null
  switch (name) {
    case 'ingest': return counts.ingested
    case 'transcribe': return counts.transcribed
    case 'summarize': return counts.summarized
    case 'compliance': return counts.complianceChecked
    default: return null
  }
}

function formatJobDescription(job: { name: string; data?: Record<string, unknown>; progress?: { current?: number; total?: number; episodeId?: number; showName?: string; airDate?: string } | null }): string {
  const p = job.progress
  if (p?.showName) {
    const parts = [p.showName]
    if (p.airDate) parts.push(p.airDate)
    if (p.current && p.total) parts.push(`(${p.current}/${p.total})`)
    return parts.join(' — ')
  }
  if (job.data?.show_key) return `${job.name} (${String(job.data.show_key)})`
  if (job.data?.episodeId) return `${job.name} (ep ${String(job.data.episodeId).slice(0, 8)})`
  return job.name
}

interface ShowOption {
  key: string
  show_name: string
}

export default function JobsPage() {
  const queues = useQueueSSE()
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [pipelineMode, setPipelineMode] = useState<PipelineMode>('steady')
  const [failedDetails, setFailedDetails] = useState<Record<string, QueueWithFailed> & { backlog?: EpisodeBacklog } | null>(null)
  const [confirmClear, setConfirmClear] = useState<string | null>(null)
  const [sseTimedOut, setSseTimedOut] = useState(false)
  const [shows, setShows] = useState<ShowOption[]>([])
  const [complianceShowKey, setComplianceShowKey] = useState<string>('')
  const { toast } = useToast()

  // Collapsible section states
  const [queuesExpanded, setQueuesExpanded] = useState(true)
  const [backlogExpanded, setBacklogExpanded] = useState(true)
  const [currentExpanded, setCurrentExpanded] = useState(true)
  const [recentExpanded, setRecentExpanded] = useState(false)
  const [failedExpanded, setFailedExpanded] = useState(false)

  const anyLoading = actionLoading !== null

  // Fetch show list for compliance show picker
  useEffect(() => {
    fetch('/api/settings?resource=shows')
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.shows) {
          setShows(data.shows.map((s: { key: string; show_name: string }) => ({ key: s.key, show_name: s.show_name })))
        }
      })
      .catch(() => {})
  }, [])

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

  // SSE timeout fallback
  useEffect(() => {
    if (queues) {
      setSseTimedOut(false)
      return
    }
    const timeout = setTimeout(() => setSseTimedOut(true), 15000)
    return () => clearTimeout(timeout)
  }, [queues])

  async function triggerJob(action: string) {
    const backlogCount = getBacklogCount(action as typeof queueNames[number], queues?.backlog)
    if (action !== 'ingest' && backlogCount !== null && backlogCount === 0) {
      toast('success', `No episodes to ${action} this quarter`)
      return
    }
    setActionLoading(action)
    try {
      const payload: Record<string, string> = { action }
      if (action === 'compliance' && complianceShowKey) {
        payload.show_key = complianceShowKey
      }
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        const msg = backlogCount && backlogCount > 0
          ? `${queueLabels[action as typeof queueNames[number]] ?? action} job queued — ${backlogCount} episode${backlogCount !== 1 ? 's' : ''} to process`
          : `${queueLabels[action as typeof queueNames[number]] ?? action} job queued`
        toast('success', msg)
        await fetchDetails()
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

  async function advancePipeline() {
    setActionLoading('advance-pipeline')
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'advance-pipeline' }),
      })
      if (res.ok) {
        const data = await res.json()
        toast('success', data.message)
        await fetchDetails()
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to advance pipeline')
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setActionLoading(null)
  }

  // SSE timed out — show error with fallback data from polling
  if (sseTimedOut && !queues) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Jobs</h2>
        <div className="bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/40 rounded-xl p-4">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Unable to connect to live updates. Queue data may be stale.
          </p>
          <button
            onClick={() => { setSseTimedOut(false); window.location.reload() }}
            className="mt-2 px-3 py-1 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded hover:bg-amber-200 transition-colors"
          >
            Retry Connection
          </button>
        </div>
        {failedDetails && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {queueNames.map((name) => {
              const q = failedDetails[name] ?? { active: 0, waiting: 0, completed: 0, failed: 0 }
              const bl = failedDetails.backlog
              const episodeCompleted = getEpisodeCompleted(name, bl?.episodeCounts)
              const episodeFailed = bl?.episodeCounts?.failed ?? null
              return (
                <div key={name} className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark p-4 space-y-3 opacity-75">
                  <h3 className="font-semibold">{queueLabels[name]}</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <CountCell count={q.active} label="Active" bg="bg-blue-50 dark:bg-blue-900/20" text="text-blue-700 dark:text-blue-300" sub="text-blue-600 dark:text-blue-400" />
                    <CountCell count={q.waiting} label="Waiting" bg="bg-yellow-50 dark:bg-yellow-900/20" text="text-yellow-700 dark:text-yellow-300" sub="text-yellow-600 dark:text-yellow-400" />
                    <CountCell count={episodeCompleted ?? 0} label="Completed" bg="bg-green-50 dark:bg-green-900/20" text="text-green-700 dark:text-green-300" sub="text-green-600 dark:text-green-400" />
                    <CountCell count={episodeFailed ?? 0} label="Failed" bg={(episodeFailed ?? 0) > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-warm-700'} text={(episodeFailed ?? 0) > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-500 dark:text-warm-400'} sub={(episodeFailed ?? 0) > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-warm-500'} />
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

  // Collect active jobs from SSE (live, with progress) for "Currently Processing"
  const activeJobsFromSSE: (ActiveJobInfo & { queue: string })[] = []
  for (const name of queueNames) {
    const qc = queues[name]
    if (qc?.activeJobs) {
      for (const aj of qc.activeJobs) {
        activeJobsFromSSE.push({ ...aj, queue: name })
      }
    }
  }

  // Collect waiting jobs from polling data
  const waitingJobs: (JobDetail & { queue: string })[] = []
  if (failedDetails) {
    for (const name of queueNames) {
      const q = failedDetails[name] as QueueWithFailed | undefined
      if (q?.jobs) {
        for (const job of q.jobs) {
          if (job.state === 'waiting') waitingJobs.push({ ...job, queue: name })
        }
      }
    }
  }
  waitingJobs.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))

  // Collect recently completed jobs from polling data
  const recentJobs: (JobDetail & { queue: string })[] = []
  if (failedDetails) {
    for (const name of queueNames) {
      const q = failedDetails[name] as QueueWithFailed | undefined
      if (q?.jobs) {
        for (const job of q.jobs) {
          if (job.state === 'completed') recentJobs.push({ ...job, queue: name })
        }
      }
    }
  }
  recentJobs.sort((a, b) => (b.finishedOn ?? 0) - (a.finishedOn ?? 0))

  // Failed jobs
  const anyQueueHasFailed = queueNames.some((name) => {
    const sseCount = queues[name]?.failed ?? 0
    const polledCount = failedDetails?.[name]?.failedJobs?.length ?? 0
    return sseCount > 0 || polledCount > 0
  })
  const totalFailedJobs = queueNames.reduce((sum, name) => {
    return sum + (failedDetails?.[name]?.failedJobs?.length ?? 0)
  }, 0)

  const totalBacklog = queues?.backlog
    ? (queues.backlog.pendingTranscription + queues.backlog.pendingSummarization + queues.backlog.pendingCompliance)
    : 0

  const hasBacklog = queues?.backlog && (queues.backlog.pendingTranscription > 0 || queues.backlog.pendingSummarization > 0 || queues.backlog.pendingCompliance > 0 || queues.backlog.failed > 0)

  const totalCurrentJobs = activeJobsFromSSE.length + waitingJobs.length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Jobs</h2>
        <button
          onClick={advancePipeline}
          disabled={anyLoading}
          className="px-5 py-2.5 text-sm font-semibold bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-sm"
        >
          {actionLoading === 'advance-pipeline' ? 'Starting...' : totalBacklog > 0 ? `Advance Pipeline (${totalBacklog} episodes)` : 'Advance Pipeline'}
        </button>
      </div>

      {/* Queue Cards — collapsible */}
      <CollapsibleSection
        title="Queues"
        expanded={queuesExpanded}
        onToggle={() => setQueuesExpanded(!queuesExpanded)}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {queueNames.map((name) => {
            const q = queues[name] ?? { active: 0, waiting: 0, completed: 0, failed: 0 }
            const backlogCount = getBacklogCount(name, queues?.backlog)
            const episodeCompleted = getEpisodeCompleted(name, queues?.backlog?.episodeCounts)
            const episodeFailed = queues?.backlog?.episodeCounts?.failed ?? null
            return (
              <div key={name} className="bg-gray-50 dark:bg-warm-800/50 rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{queueLabels[name]}</h3>
                  <button
                    onClick={() => triggerJob(name)}
                    disabled={anyLoading}
                    className="px-3 py-1 text-xs bg-gray-900 text-white rounded hover:bg-gray-800 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100 disabled:opacity-50 transition-colors"
                  >
                    {actionLoading === name ? 'Queuing...' : 'Run Now'}
                  </button>
                </div>
                {name === 'compliance' && shows.length > 0 && (
                  <select
                    value={complianceShowKey}
                    onChange={(e) => setComplianceShowKey(e.target.value)}
                    className="w-full text-xs border rounded px-2 py-1 bg-white dark:bg-warm-800 dark:border-warm-600 dark:text-warm-200"
                  >
                    <option value="">All shows</option>
                    {shows.map((s) => (
                      <option key={s.key} value={s.key}>{s.show_name}</option>
                    ))}
                  </select>
                )}
                {backlogCount !== null && backlogCount > 0 && (
                  <div className="bg-orange-50 border border-orange-200 dark:bg-orange-900/20 dark:border-orange-800/40 rounded px-3 py-1.5 text-sm">
                    <span className="font-semibold text-orange-700 dark:text-orange-300">{backlogCount}</span>
                    <span className="text-orange-600 dark:text-orange-400 ml-1">episode{backlogCount !== 1 ? 's' : ''} waiting</span>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <CountCell count={q.active} label="Active" bg="bg-blue-50 dark:bg-blue-900/20" text="text-blue-700 dark:text-blue-300" sub="text-blue-600 dark:text-blue-400" />
                  <CountCell count={q.waiting} label="Queued" bg="bg-yellow-50 dark:bg-yellow-900/20" text="text-yellow-700 dark:text-yellow-300" sub="text-yellow-600 dark:text-yellow-400" />
                  <CountCell count={episodeCompleted ?? 0} label="Completed" bg="bg-green-50 dark:bg-green-900/20" text="text-green-700 dark:text-green-300" sub="text-green-600 dark:text-green-400" />
                  <CountCell count={episodeFailed ?? 0} label="Failed" bg={(episodeFailed ?? 0) > 0 ? 'bg-red-50 dark:bg-red-900/20' : 'bg-gray-50 dark:bg-warm-700'} text={(episodeFailed ?? 0) > 0 ? 'text-red-700 dark:text-red-300' : 'text-gray-500 dark:text-warm-400'} sub={(episodeFailed ?? 0) > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-warm-500'} />
                </div>
              </div>
            )
          })}
        </div>
      </CollapsibleSection>

      {/* Episode Pipeline Backlog — collapsible */}
      {hasBacklog && (
        <CollapsibleSection
          title="Episode Pipeline Backlog"
          badge={`${totalBacklog + (queues.backlog?.failed ?? 0)}`}
          badgeColor="orange"
          expanded={backlogExpanded}
          onToggle={() => setBacklogExpanded(!backlogExpanded)}
        >
          <div className="flex flex-wrap gap-4 text-sm">
            {queues.backlog!.pendingTranscription > 0 && (
              <span className="text-orange-700 dark:text-orange-300">
                <span className="font-semibold">{queues.backlog!.pendingTranscription}</span> awaiting transcription
              </span>
            )}
            {queues.backlog!.pendingSummarization > 0 && (
              <span className="text-orange-700 dark:text-orange-300">
                <span className="font-semibold">{queues.backlog!.pendingSummarization}</span> awaiting summarization
              </span>
            )}
            {queues.backlog!.pendingCompliance > 0 && (
              <span className="text-orange-700 dark:text-orange-300">
                <span className="font-semibold">{queues.backlog!.pendingCompliance}</span> awaiting QIR generation
              </span>
            )}
            {queues.backlog!.failed > 0 && (
              <span className="text-red-600 dark:text-red-400">
                <span className="font-semibold">{queues.backlog!.failed}</span> failed episodes
              </span>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Current Jobs — active + waiting, collapsible */}
      {totalCurrentJobs > 0 && (
        <CollapsibleSection
          title="Current Jobs"
          badges={[
            activeJobsFromSSE.length > 0 ? { text: `${activeJobsFromSSE.length} active`, color: 'blue' as const } : null,
            waitingJobs.length > 0 ? { text: `${waitingJobs.length} waiting`, color: 'yellow' as const } : null,
          ].filter(Boolean) as { text: string; color: 'blue' | 'yellow' }[]}
          expanded={currentExpanded}
          onToggle={() => setCurrentExpanded(!currentExpanded)}
        >
          <div className="divide-y dark:divide-warm-700">
            {activeJobsFromSSE.map((job) => (
              <div key={`${job.queue}-${job.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="shrink-0 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                <span className="text-xs font-medium text-gray-400 dark:text-warm-500 uppercase w-20 shrink-0">
                  {queueLabels[job.queue as typeof queueNames[number]] ?? job.queue}
                </span>
                <span className="text-gray-700 dark:text-warm-300 truncate flex-1 min-w-0">
                  {formatJobDescription(job)}
                </span>
                {job.progress?.current && job.progress?.total && (
                  <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0">
                    {job.progress.current}/{job.progress.total}
                  </span>
                )}
                <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0 tabular-nums">
                  {job.processedOn ? `running ${formatDuration(Date.now() - job.processedOn)}` : ''}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                  active
                </span>
              </div>
            ))}
            {waitingJobs.map((job) => (
              <div key={`${job.queue}-${job.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="shrink-0 w-2 h-2 rounded-full bg-yellow-400" />
                <span className="text-xs font-medium text-gray-400 dark:text-warm-500 uppercase w-20 shrink-0">
                  {queueLabels[job.queue as typeof queueNames[number]] ?? job.queue}
                </span>
                <span className="text-gray-700 dark:text-warm-300 truncate flex-1 min-w-0">
                  {formatJobDescription(job)}
                </span>
                <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0 tabular-nums">
                  queued {formatRelativeTime(job.timestamp)}
                </span>
                <span className="text-xs px-1.5 py-0.5 rounded font-medium shrink-0 bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300">
                  waiting
                </span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Recent Jobs — completed, collapsible */}
      {recentJobs.length > 0 && (
        <CollapsibleSection
          title="Recent Jobs"
          badge={`${recentJobs.length}`}
          badgeColor="green"
          expanded={recentExpanded}
          onToggle={() => setRecentExpanded(!recentExpanded)}
        >
          <div className="divide-y dark:divide-warm-700">
            {recentJobs.map((job) => (
              <div key={`${job.queue}-${job.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                <span className="shrink-0 w-2 h-2 rounded-full bg-green-400" />
                <span className="text-xs font-medium text-gray-400 dark:text-warm-500 uppercase w-20 shrink-0">
                  {queueLabels[job.queue as typeof queueNames[number]] ?? job.queue}
                </span>
                <span className="text-gray-700 dark:text-warm-300 truncate flex-1 min-w-0">
                  {job.name}
                  {job.returnvalue && Object.keys(job.returnvalue).length > 0 && (
                    <span className="text-gray-400 dark:text-warm-500 ml-1">
                      ({Object.entries(job.returnvalue).filter(([, v]) => v !== null && v !== undefined && v !== false && v !== 0).map(([k, v]) => `${k}: ${v}`).join(', ')})
                    </span>
                  )}
                </span>
                <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0 tabular-nums">
                  {job.finishedOn && job.processedOn
                    ? `took ${formatDuration(job.finishedOn - job.processedOn)}`
                    : job.finishedOn
                    ? formatRelativeTime(job.finishedOn)
                    : ''}
                </span>
                <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0 tabular-nums">
                  {job.finishedOn ? formatRelativeTime(job.finishedOn) : ''}
                </span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Failed Jobs — collapsible */}
      {anyQueueHasFailed && (
        <CollapsibleSection
          title="Failed Jobs"
          badge={`${totalFailedJobs > 0 ? totalFailedJobs : '...'}`}
          badgeColor="red"
          expanded={failedExpanded}
          onToggle={() => setFailedExpanded(!failedExpanded)}
        >
          <div className="space-y-4">
            {queueNames.map((name) => {
              const q = failedDetails?.[name]
              const jobs = q?.failedJobs ?? []
              if (jobs.length === 0) return null
              return (
                <div key={name} className="pt-2 first:pt-0">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-warm-300">
                      {queueLabels[name]} <span className="text-red-500 font-normal">({jobs.length} failed)</span>
                    </h4>
                    <div className="flex gap-2">
                      <button
                        onClick={() => retryFailed(name)}
                        disabled={anyLoading}
                        className="px-2 py-1 text-xs bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 rounded hover:bg-amber-200 disabled:opacity-50 transition-colors"
                      >
                        {actionLoading === `retry-${name}` ? 'Retrying...' : 'Retry All Failed'}
                      </button>
                      <button
                        onClick={() => setConfirmClear(name)}
                        disabled={anyLoading}
                        className="px-2 py-1 text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded hover:bg-red-200 disabled:opacity-50 transition-colors"
                      >
                        {actionLoading === `clear-${name}` ? 'Clearing...' : 'Clear Failed'}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1">
                    {jobs.map((job) => (
                      <div key={job.id} className="flex items-start gap-3 text-sm bg-red-50/50 dark:bg-red-900/15 rounded px-3 py-2">
                        <span className="text-gray-400 dark:text-warm-500 font-mono text-xs shrink-0 pt-0.5">
                          #{job.id}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-gray-700 dark:text-warm-300 truncate">
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
        </CollapsibleSection>
      )}

      {/* Pipeline Mode Toggle */}
      <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Pipeline Mode</h3>
            <p className="text-sm text-gray-600 dark:text-warm-400 mt-1">
              {pipelineMode === 'steady'
                ? 'Steady: 1 transcribe / 5 summarize concurrent.'
                : 'Catch-up: 3 transcribe / 10 summarize concurrent.'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className={`text-sm font-medium px-2 py-0.5 rounded ${
              pipelineMode === 'steady'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
            }`}>
              {pipelineMode === 'steady' ? 'Steady' : 'Catch-up'}
            </span>
            <button
              onClick={togglePipelineMode}
              disabled={anyLoading}
              className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100 disabled:opacity-50 transition-colors"
            >
              {actionLoading === 'pipeline-mode' ? 'Switching...' : `Switch to ${pipelineMode === 'steady' ? 'Catch-up' : 'Steady'}`}
            </button>
          </div>
        </div>
      </div>

      {/* Cron Schedule Reference */}
      <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark p-4">
        <h3 className="font-semibold mb-3">Cron Schedule</h3>
        <div className="space-y-1.5 text-sm text-gray-600 dark:text-warm-400">
          <p>Ingest runs at minute :02 of every hour (does not auto-trigger other stages).</p>
          <p>Transcribe, Summarize, and Compliance must be triggered manually via Run Now or Advance Pipeline.</p>
          <p>Within a stage, batches auto-continue until all pending episodes are processed.</p>
          <p>Auto-retry runs every 4 hours for failed episodes (max 3 retries).</p>
        </div>
        <p className="text-xs text-gray-400 dark:text-warm-500 mt-3">
          Live updates via server-sent events.
        </p>
      </div>

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

// --- Shared Components ---

function CollapsibleSection({ title, badge, badgeColor, badges, expanded, onToggle, children }: {
  title: string
  badge?: string
  badgeColor?: 'blue' | 'yellow' | 'green' | 'red' | 'orange'
  badges?: { text: string; color: 'blue' | 'yellow' | 'green' | 'red' | 'orange' }[]
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  const colorMap = {
    blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
    yellow: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
    green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    orange: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-warm-700/50 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-2">
          <h3 className="font-semibold">{title}</h3>
          {badge && (
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colorMap[badgeColor ?? 'blue']}`}>
              {badge}
            </span>
          )}
          {badges?.map((b, i) => (
            <span key={i} className={`text-xs px-2 py-0.5 rounded-full font-medium ${colorMap[b.color]}`}>
              {b.text}
            </span>
          ))}
        </div>
        <svg
          className={`w-5 h-5 text-gray-400 dark:text-warm-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t dark:border-warm-700 px-4 pb-4 pt-3">
          {children}
        </div>
      )}
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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSec = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainSec}s`
  const hours = Math.floor(minutes / 60)
  const remainMin = minutes % 60
  return `${hours}h ${remainMin}m`
}
