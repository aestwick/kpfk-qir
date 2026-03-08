'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Breadcrumbs } from '@/app/components/breadcrumbs'

interface Episode {
  id: number
  show_name: string | null
  show_key: string
  status: string
  air_date: string | null
  duration: number | null
  headline: string | null
  issue_category: string | null
  created_at: string
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized: 'bg-green-100 text-green-800',
  compliance_checked: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  transcribed: 'Transcribed',
  summarized: 'Summarized',
  compliance_checked: 'Checked',
  failed: 'Failed',
  unavailable: 'Unavailable',
}

export default function ShowPage() {
  const params = useParams()
  const router = useRouter()
  const showKey = decodeURIComponent(params.showKey as string)

  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [showName, setShowName] = useState<string>(showKey)
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const limit = 50

  const fetchEpisodes = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      show_key: showKey,
      page: String(page),
      limit: String(limit),
      sort: 'air_date',
      order: 'desc',
    })
    if (statusFilter) params.set('status', statusFilter)

    const res = await fetch(`/api/episodes?${params}`)
    if (res.ok) {
      const data = await res.json()
      const eps = data.episodes ?? []
      setEpisodes(eps)
      setTotal(data.total ?? 0)
      if (eps.length > 0 && eps[0].show_name) {
        setShowName(eps[0].show_name)
      }
    }
    setLoading(false)
  }, [showKey, statusFilter, page])

  useEffect(() => { fetchEpisodes() }, [fetchEpisodes])

  // Count by status
  const statusCounts: Record<string, number> = {}
  // We'll compute from the full set — for now show what's loaded
  // A more accurate approach would be a dedicated API, but this works for the page

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="space-y-5">
      <Breadcrumbs episodeName={showName} />

      <div className="flex items-center gap-3">
        <a href="/dashboard/episodes" className="text-sm text-gray-500 hover:text-gray-700">&larr; Episodes</a>
        <h2 className="text-2xl font-bold">{showName}</h2>
        <span className="text-sm text-gray-400">({total} episodes)</span>
      </div>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { setStatusFilter(''); setPage(1) }}
          className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-colors ${
            !statusFilter ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          }`}
        >
          All
        </button>
        {['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'].map((s) => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setPage(1) }}
            className={`px-3 py-1.5 text-xs rounded-lg border font-medium transition-colors ${
              statusFilter === s ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
            }`}
          >
            {statusLabels[s] ?? s}
          </button>
        ))}
      </div>

      {/* Episode list */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        {loading ? (
          <div className="divide-y">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center gap-4 animate-pulse">
                <div className="h-4 w-20 bg-gray-200 rounded" />
                <div className="h-4 w-16 bg-gray-200 rounded" />
                <div className="h-4 flex-1 bg-gray-200 rounded" />
              </div>
            ))}
          </div>
        ) : episodes.length === 0 ? (
          <div className="px-5 py-12 text-center text-gray-400">No episodes found</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {episodes.map((ep) => (
              <a
                key={ep.id}
                href={`/dashboard/episodes/${ep.id}`}
                className="px-5 py-3.5 flex items-center gap-4 hover:bg-gray-50 transition-colors"
              >
                <span className="text-sm text-gray-500 w-24 shrink-0 tabular-nums">
                  {ep.air_date ?? '—'}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColors[ep.status] ?? 'bg-gray-100 text-gray-500'}`}>
                  {statusLabels[ep.status] ?? ep.status}
                </span>
                <span className="text-sm text-gray-800 truncate flex-1">
                  {ep.headline ?? '—'}
                </span>
                {ep.duration && (
                  <span className="text-xs text-gray-400 shrink-0 tabular-nums">{ep.duration}m</span>
                )}
                {ep.issue_category && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 shrink-0 hidden md:inline">
                    {ep.issue_category}
                  </span>
                )}
              </a>
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t px-5 py-3 flex items-center justify-between text-sm text-gray-600">
            <span>{total} episodes total</span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-50"
              >
                Previous
              </button>
              <span className="px-3 py-1">Page {page} of {totalPages}</span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
