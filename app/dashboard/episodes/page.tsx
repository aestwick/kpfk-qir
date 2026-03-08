'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

interface Episode {
  id: number
  show_key: string
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
  compliance_checked: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

export default function EpisodesPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const [episodes, setEpisodes] = useState<Episode[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [issueCategories, setIssueCategories] = useState<string[]>([])

  // Inline category editing state
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null)
  const [savingCategoryId, setSavingCategoryId] = useState<number | null>(null)
  const [savedCategoryId, setSavedCategoryId] = useState<number | null>(null)

  // Confirm dialog state
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Read initial state from URL params
  const statusFilter = searchParams.get('status') ?? ''
  const quarterFilter = searchParams.get('quarter') ?? ''
  const showFilterParam = searchParams.get('show') ?? ''
  const categoryFilterParam = searchParams.get('category') ?? ''
  const sort = searchParams.get('sort') ?? 'created_at'
  const order = searchParams.get('order') ?? 'desc'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const limit = 50

  // Local state for text inputs (decoupled from URL for responsive typing)
  const [showFilterLocal, setShowFilterLocal] = useState(showFilterParam)

  // Sync local state when URL params change externally (e.g. browser back/forward)
  useEffect(() => { setShowFilterLocal(showFilterParam) }, [showFilterParam])

  // Use URL param values for API calls (these are the "committed" filter values)
  const showFilter = showFilterParam
  const categoryFilter = categoryFilterParam

  const updateParamsRef = useRef(searchParams)
  updateParamsRef.current = searchParams

  const updateParams = useCallback((updates: Record<string, string>) => {
    const params = new URLSearchParams(updateParamsRef.current.toString())
    for (const [key, value] of Object.entries(updates)) {
      if (value) {
        params.set(key, value)
      } else {
        params.delete(key)
      }
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [router, pathname])

  function setStatusFilter(v: string) { updateParams({ status: v, page: '' }) }
  function setQuarterFilter(v: string) { updateParams({ quarter: v, page: '' }) }
  function setCategoryFilterValue(v: string) { updateParams({ category: v, page: '' }) }
  function setPage(p: number) { updateParams({ page: p <= 1 ? '' : String(p) }) }

  // Debounce text filter updates to URL
  const showDebounceRef = useRef<ReturnType<typeof setTimeout>>()

  function setShowFilter(v: string) {
    setShowFilterLocal(v)
    clearTimeout(showDebounceRef.current)
    showDebounceRef.current = setTimeout(() => {
      updateParams({ show: v, page: '' })
    }, 350)
  }

  // Fetch issue categories from settings
  useEffect(() => {
    async function fetchCategories() {
      try {
        const res = await fetch('/api/settings')
        if (res.ok) {
          const data = await res.json()
          const cats = data.settings?.issue_categories
          if (Array.isArray(cats)) {
            setIssueCategories(cats)
          } else {
            // Fallback defaults
            setIssueCategories([
              'Civil Rights / Social Justice',
              'Immigration',
              'Economy / Labor',
              'Environment / Climate',
              'Government / Politics',
              'Health',
              'International Affairs / War & Peace',
              'Arts & Culture',
            ])
          }
        }
      } catch {
        // Use fallback
      }
    }
    fetchCategories()
  }, [])

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
      updateParams({ order: order === 'asc' ? 'desc' : 'asc', page: '' })
    } else {
      updateParams({ sort: col, order: 'desc', page: '' })
    }
  }

  async function handleBulkRetry() {
    try {
      const res = await fetch('/api/episodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk-retry' }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.error ?? 'Failed to retry episodes')
        return
      }
    } catch {
      alert('Network error: could not reach server')
      return
    }
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

  // Inline category save
  async function handleCategorySave(episodeId: number, newCategory: string) {
    setSavingCategoryId(episodeId)
    try {
      const res = await fetch(`/api/episodes/${episodeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issue_category: newCategory }),
      })
      if (res.ok) {
        // Update local state optimistically
        setEpisodes((prev) =>
          prev.map((ep) =>
            ep.id === episodeId ? { ...ep, issue_category: newCategory } : ep
          )
        )
        // Show brief checkmark
        setSavedCategoryId(episodeId)
        setTimeout(() => setSavedCategoryId(null), 1500)
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setSavingCategoryId(null)
      setEditingCategoryId(null)
    }
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

  const [selectedRow, setSelectedRow] = useState(-1)
  const showFilterRef = useRef<HTMLInputElement>(null)

  // Keyboard shortcuts: j/k navigate, Enter opens, / focuses search, Escape deselects/blurs, r retries
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      const isInput = target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'

      if (e.key === 'Escape') {
        if (isInput) {
          (target as HTMLInputElement).blur()
        }
        setSelectedRow(-1)
        setEditingCategoryId(null)
        return
      }

      if (e.key === '/' && !isInput) {
        e.preventDefault()
        showFilterRef.current?.focus()
        return
      }

      if (isInput) return

      if (e.key === 'j') {
        setSelectedRow((r) => Math.min(r + 1, episodes.length - 1))
      } else if (e.key === 'k') {
        setSelectedRow((r) => Math.max(r - 1, 0))
      } else if (e.key === 'Enter' && selectedRow >= 0 && selectedRow < episodes.length) {
        router.push(`/dashboard/episodes/${episodes[selectedRow].id}`)
      } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        setConfirmOpen(true)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [episodes, selectedRow, router])

  // Reset selected row when episodes change
  useEffect(() => { setSelectedRow(-1) }, [episodes])

  const SortIcon = ({ col }: { col: string }) => {
    if (sort !== col) return <span className="text-gray-300 ml-1">&#8597;</span>
    return <span className="ml-1">{order === 'asc' ? '&#8593;' : '&#8595;'}</span>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Episodes</h2>
        <div className="flex gap-2">
          <button onClick={() => setConfirmOpen(true)} className="px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700">
            Retry Failed
          </button>
          <button onClick={handleExportCSV} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
          <option value="">All Statuses</option>
          {['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={quarterFilter} onChange={(e) => setQuarterFilter(e.target.value)} className="border rounded px-2 py-1.5 text-sm">
          <option value="">All Quarters</option>
          {quarterOptions.map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
        <input
          ref={showFilterRef}
          type="text"
          placeholder="Filter by show name... (press /)"
          value={showFilterLocal}
          onChange={(e) => setShowFilter(e.target.value)}
          className="border rounded px-2 py-1.5 text-sm w-48"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilterValue(e.target.value)}
          className="border rounded px-2 py-1.5 text-sm"
        >
          <option value="">All Categories</option>
          {issueCategories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>
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
              <th className="text-left px-4 py-3 font-medium cursor-pointer" onClick={() => handleSort('issue_category')}>
                Category <SortIcon col="issue_category" />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <SkeletonTableRows rows={8} />
            ) : episodes.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No episodes found</td></tr>
            ) : episodes.map((ep, i) => (
              <tr
                key={ep.id}
                className={`hover:bg-gray-50 cursor-pointer ${i === selectedRow ? 'bg-blue-50 ring-1 ring-blue-300' : ''}`}
                onClick={(e) => {
                  // Don't navigate if clicking on the category cell editing area
                  const target = e.target as HTMLElement
                  if (target.closest('[data-category-cell]')) return
                  router.push(`/dashboard/episodes/${ep.id}`)
                }}
              >
                <td className="px-4 py-3 max-w-[200px] truncate">
                  <a
                    href={`/dashboard/shows/${encodeURIComponent(ep.show_key)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-blue-600 hover:underline"
                  >
                    {ep.show_name ?? ep.id}
                  </a>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">{ep.air_date ?? '—'}</td>
                <td className="px-4 py-3 whitespace-nowrap">{ep.duration ? `${ep.duration}m` : '—'}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[ep.status] ?? 'bg-gray-100'}`}>{ep.status}</span>
                </td>
                <td className="px-4 py-3 max-w-[250px] truncate">{ep.headline ?? '—'}</td>
                <td className="px-4 py-3 max-w-[180px]" data-category-cell>
                  {editingCategoryId === ep.id ? (
                    <select
                      autoFocus
                      className="border rounded px-1.5 py-0.5 text-sm w-full bg-white"
                      defaultValue={ep.issue_category ?? ''}
                      onChange={(e) => handleCategorySave(ep.id, e.target.value)}
                      onBlur={() => setEditingCategoryId(null)}
                      disabled={savingCategoryId === ep.id}
                    >
                      <option value="">—</option>
                      {issueCategories.map((cat) => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 group"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditingCategoryId(ep.id)
                      }}
                    >
                      <span className="truncate">{ep.issue_category ?? '—'}</span>
                      {savedCategoryId === ep.id ? (
                        <span className="text-green-600 text-xs font-medium">&#10003;</span>
                      ) : (
                        <span className="text-gray-300 group-hover:text-gray-500 text-xs opacity-0 group-hover:opacity-100 transition-opacity">&#9998;</span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Keyboard hints */}
      <p className="text-[10px] text-gray-400">
        Shortcuts: <kbd className="px-1 bg-gray-100 rounded">j</kbd>/<kbd className="px-1 bg-gray-100 rounded">k</kbd> navigate &middot; <kbd className="px-1 bg-gray-100 rounded">Enter</kbd> open &middot; <kbd className="px-1 bg-gray-100 rounded">/</kbd> search &middot; <kbd className="px-1 bg-gray-100 rounded">Esc</kbd> deselect &middot; <kbd className="px-1 bg-gray-100 rounded">r</kbd> retry failed
      </p>

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

      {/* Confirm Dialog for Retry */}
      <ConfirmDialog
        open={confirmOpen}
        title="Retry Failed Episodes"
        message="This will reset all failed episodes back to pending for re-processing. Continue?"
        confirmLabel="Retry All"
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmOpen(false)
          handleBulkRetry()
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}
