'use client'

import { useEffect, useState, useCallback } from 'react'
import { SkeletonTableRows } from '@/app/components/skeleton'

interface Episode {
  id: number
  show_name: string | null
  category: string | null
  status: string
  air_date: string | null
  start_time: string | null
  duration: number | null
  headline: string | null
  issue_category: string | null
  created_at: string
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

export default function EpisodesPage() {
  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [quarterFilter, setQuarterFilter] = useState('')
  const [showFilter, setShowFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [sort, setSort] = useState('created_at')
  const [order, setOrder] = useState('desc')
  const limit = 50

  const fetchEpisodes = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), limit: String(limit), sort, order })
    if (statusFilter) params.set('status', statusFilter)
    if (quarterFilter) params.set('quarter', quarterFilter)
    if (showFilter) params.set('show', showFilter)
    if (categoryFilter) params.set('category', categoryFilter)

    const res = await fetch(`/api/episodes?${params}`)
    if (res.ok) {
      const data = await res.json()
      setEpisodes(data.episodes ?? [])
      setTotal(data.total ?? 0)
    }
    setLoading(false)
  }, [page, statusFilter, quarterFilter, showFilter, categoryFilter, sort, order])

  useEffect(() => { fetchEpisodes() }, [fetchEpisodes])

  function handleSort(col: string) {
    if (sort === col) {
      setOrder(order === 'asc' ? 'desc' : 'asc')
    } else {
      setSort(col)
      setOrder('desc')
    }
    setPage(1)
  }

  async function handleBulkRetry() {
    if (!confirm('Retry all failed episodes?')) return
    await fetch('/api/episodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bulk-retry' }),
    })
    fetchEpisodes()
  }

  function handleExportCSV() {
    const params = new URLSearchParams({ format: 'csv', limit: '10000', page: '1', sort, order })
    if (statusFilter) params.set('status', statusFilter)
    if (quarterFilter) params.set('quarter', quarterFilter)
    if (showFilter) params.set('show', showFilter)
    if (categoryFilter) params.set('category', categoryFilter)
    window.open(`/api/episodes?${params}`, '_blank')
  }

  const totalPages = Math.ceil(total / limit)

  // Generate quarter options
  const quarterOptions: string[] = []
  const now = new Date()
  for (let y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
    for (let q = 4; q >= 1; q--) {
      quarterOptions.push(`${y}-Q${q}`)
    }
  }

  const SortIcon = ({ col }: { col: string }) => {
    if (sort !== col) return <span className="text-gray-300 ml-1">&#8597;</span>
    return <span className="ml-1">{order === 'asc' ? '&#8593;' : '&#8595;'}</span>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Episodes</h2>
        <div className="flex gap-2">
          <button onClick={handleBulkRetry} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">
            Retry Failed
          </button>
          <button onClick={handleExportCSV} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }} className="border rounded px-2 py-1.5 text-sm">
          <option value="">All Statuses</option>
          {['pending', 'transcribed', 'summarized', 'failed', 'unavailable'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={quarterFilter} onChange={(e) => { setQuarterFilter(e.target.value); setPage(1) }} className="border rounded px-2 py-1.5 text-sm">
          <option value="">All Quarters</option>
          {quarterOptions.map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Filter by show name..."
          value={showFilter}
          onChange={(e) => { setShowFilter(e.target.value); setPage(1) }}
          className="border rounded px-2 py-1.5 text-sm w-48"
        />
        <input
          type="text"
          placeholder="Filter by category..."
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1) }}
          className="border rounded px-2 py-1.5 text-sm w-48"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg shadow overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium cursor-pointer" onClick={() => handleSort('show_name')}>
                Show <SortIcon col="show_name" />
              </th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer" onClick={() => handleSort('air_date')}>
                Air Date <SortIcon col="air_date" />
              </th>
              <th className="text-left px-4 py-3 font-medium">Duration</th>
              <th className="text-left px-4 py-3 font-medium cursor-pointer" onClick={() => handleSort('status')}>
                Status <SortIcon col="status" />
              </th>
              <th className="text-left px-4 py-3 font-medium">Headline</th>
              <th className="text-left px-4 py-3 font-medium">Category</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <SkeletonTableRows rows={8} />
            ) : episodes.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No episodes found</td></tr>
            ) : episodes.map((ep) => (
              <tr key={ep.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => window.location.href = `/dashboard/episodes/${ep.id}`}>
                <td className="px-4 py-3 max-w-[200px] truncate">{ep.show_name ?? ep.id}</td>
                <td className="px-4 py-3 whitespace-nowrap">{ep.air_date ?? '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap">{ep.duration ? `${ep.duration}m` : '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[ep.status] ?? 'bg-gray-100'}`}>{ep.status}</span>
                </td>
                <td className="px-4 py-3 max-w-[250px] truncate">{ep.headline ?? '—'}</td>
                <td className="px-4 py-3 max-w-[150px] truncate">{ep.issue_category ?? ep.category ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">{total} episodes total</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-3 py-1.5 text-sm">Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
