'use client'

import { useEffect, useState, useCallback } from 'react'

interface StatusCounts {
  pending: number
  transcribed: number
  summarized: number
  failed: number
  unavailable: number
}

interface RecentEpisode {
  id: number
  show_name: string | null
  headline: string | null
  status: string
  updated_at: string
}

function getQuarterBounds() {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const start = new Date(now.getFullYear(), q * 3, 1)
  const end = new Date(now.getFullYear(), q * 3 + 3, 0)
  return {
    label: `Q${q + 1} ${now.getFullYear()}`,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

export default function DashboardOverview() {
  const [counts, setCounts] = useState<StatusCounts | null>(null)
  const [recent, setRecent] = useState<RecentEpisode[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const quarter = getQuarterBounds()

  const fetchData = useCallback(async () => {
    try {
      const [countsRes, recentRes] = await Promise.all([
        fetch('/api/episodes/counts'),
        fetch('/api/episodes?limit=10&page=1'),
      ])
      if (countsRes.ok) setCounts(await countsRes.json())
      if (recentRes.ok) {
        const data = await recentRes.json()
        setRecent(data.episodes ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  async function triggerAction(action: string) {
    setActionLoading(action)
    try {
      await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      setTimeout(fetchData, 2000)
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) return <p className="text-gray-500">Loading...</p>

  const total = counts ? counts.pending + counts.transcribed + counts.summarized + counts.failed + counts.unavailable : 0
  const processed = counts ? counts.summarized : 0
  const progressPct = total > 0 ? Math.round((processed / total) * 100) : 0

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Dashboard</h2>

      {/* Status Counts */}
      <div className="grid grid-cols-5 gap-4">
        {counts && Object.entries(counts).map(([status, count]) => (
          <div key={status} className="bg-white rounded-lg shadow p-4">
            <p className="text-sm text-gray-500 capitalize">{status}</p>
            <p className="text-2xl font-bold">{count}</p>
          </div>
        ))}
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">Quick Actions</h3>
        <div className="flex gap-3">
          {(['ingest', 'transcribe', 'summarize'] as const).map((action) => (
            <button
              key={action}
              onClick={() => triggerAction(action)}
              disabled={actionLoading !== null}
              className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 disabled:opacity-50 capitalize"
            >
              {actionLoading === action ? 'Running...' : `Run ${action}`}
            </button>
          ))}
        </div>
      </div>

      {/* Quarter Progress */}
      <div className="bg-white rounded-lg shadow p-4">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">{quarter.label} Progress</h3>
        <div className="w-full bg-gray-200 rounded-full h-4">
          <div
            className="bg-green-500 h-4 rounded-full transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <p className="text-sm text-gray-500 mt-1">{processed} of {total} episodes summarized ({progressPct}%)</p>
      </div>

      {/* Recent Activity */}
      <div className="bg-white rounded-lg shadow">
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold text-gray-500 uppercase">Recent Activity</h3>
        </div>
        <div className="divide-y">
          {recent.map((ep) => (
            <a key={ep.id} href={`/dashboard/episodes/${ep.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-gray-50">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{ep.show_name ?? ep.id}</p>
                <p className="text-xs text-gray-500 truncate">{ep.headline ?? 'No headline'}</p>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ml-3 ${statusColors[ep.status] ?? 'bg-gray-100'}`}>
                {ep.status}
              </span>
            </a>
          ))}
          {recent.length === 0 && <p className="px-4 py-3 text-sm text-gray-500">No episodes yet</p>}
        </div>
      </div>
    </div>
  )
}
