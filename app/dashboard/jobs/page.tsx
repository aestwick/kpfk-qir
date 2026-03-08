'use client'

import { useState } from 'react'
import { SkeletonCard } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { useQueueSSE } from '@/lib/use-sse'

export default function JobsPage() {
  const queues = useQueueSSE()
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const { toast } = useToast()

  async function triggerJob(action: string) {
    setActionLoading(action)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? `Failed to queue ${action}`)
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setTimeout(() => setActionLoading(null), 1500)
  }

  if (!queues) return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Jobs</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  )

  const queueNames = ['ingest', 'transcribe', 'summarize'] as const

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Jobs</h2>

      {/* Queue Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {queueNames.map((name) => {
          const q = queues[name]
          return (
            <div key={name} className="bg-white rounded-lg shadow p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold capitalize">{name}</h3>
                <button
                  onClick={() => triggerJob(name)}
                  disabled={actionLoading !== null}
                  className="px-3 py-1 text-xs bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
                >
                  {actionLoading === name ? 'Queuing...' : 'Run Now'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-blue-50 rounded p-2 text-center">
                  <p className="text-lg font-bold text-blue-700">{q.active}</p>
                  <p className="text-xs text-blue-600">Active</p>
                </div>
                <div className="bg-yellow-50 rounded p-2 text-center">
                  <p className="text-lg font-bold text-yellow-700">{q.waiting}</p>
                  <p className="text-xs text-yellow-600">Waiting</p>
                </div>
                <div className="bg-green-50 rounded p-2 text-center">
                  <p className="text-lg font-bold text-green-700">{q.completed}</p>
                  <p className="text-xs text-green-600">Completed</p>
                </div>
                <div className="bg-red-50 rounded p-2 text-center">
                  <p className="text-lg font-bold text-red-700">{q.failed}</p>
                  <p className="text-xs text-red-600">Failed</p>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Cron Info */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="font-semibold mb-2">Cron Schedule</h3>
        <p className="text-sm text-gray-600">
          Ingest runs automatically at minute :02 of every hour via BullMQ repeating jobs.
          Transcription triggers after ingest finds new episodes. Summarization triggers after transcription completes.
        </p>
        <p className="text-sm text-gray-500 mt-2">
          Live updates via server-sent events.
        </p>
      </div>
    </div>
  )
}
