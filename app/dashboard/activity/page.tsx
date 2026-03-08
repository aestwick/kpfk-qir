'use client'

import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SkeletonBlock } from '@/app/components/skeleton'

interface ActivityEntry {
  id: number
  show_name: string | null
  show_key: string | null
  status: string
  updated_at: string
  air_date: string | null
  headline: string | null
  duration: number | null
}

interface UsageEntry {
  episode_id: number | null
  operation: string
  estimated_cost: string | number
  duration_seconds: number | null
}

const BADGE_COLORS: Record<string, string> = {
  pending:              'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  transcribed:          'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  summarized:           'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300',
  compliance_checked:   'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  failed:               'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  unavailable:          'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-400',
  dead:                 'bg-gray-200 text-gray-700 dark:bg-warm-700 dark:text-warm-400',
}

const EVENT_FILTERS = [
  { label: 'All',          value: '' },
  { label: 'Ingested',     value: 'pending' },
  { label: 'Transcribed',  value: 'transcribed' },
  { label: 'Summarized',   value: 'summarized' },
  { label: 'Checked',      value: 'compliance_checked' },
  { label: 'Failed',       value: 'failed' },
]

const RANGE_OPTIONS = [
  { label: '24 hours', hours: 24 },
  { label: '3 days',   hours: 72 },
  { label: '7 days',   hours: 168 },
  { label: '30 days',  hours: 720 },
]

export default function ActivityPage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // Read filters from URL
  const urlRange = searchParams.get('range')
  const urlType = searchParams.get('type') ?? ''
  const urlShow = searchParams.get('show') ?? ''

  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [usageMap, setUsageMap] = useState<Map<number, { cost: number; durationSec: number | null; operation: string }>>(new Map())
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState(urlRange ? parseInt(urlRange) : 168)
  const [typeFilter, setTypeFilter] = useState(urlType)
  const [showSearch, setShowSearch] = useState(urlShow)

  // Sync local state when URL params change externally (browser back/forward)
  useEffect(() => { setTypeFilter(urlType) }, [urlType])
  useEffect(() => { setShowSearch(urlShow) }, [urlShow])
  useEffect(() => {
    if (urlRange) setRange(parseInt(urlRange))
  }, [urlRange])

  // Persist filters to URL
  const updateUrl = useCallback((newRange: number, newType: string, newShow: string) => {
    const params = new URLSearchParams()
    if (newRange !== 168) params.set('range', String(newRange))
    if (newType) params.set('type', newType)
    if (newShow) params.set('show', newShow)
    const qs = params.toString()
    router.replace(`/dashboard/activity${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [router])

  // Debounce show search URL updates
  const showDebounceRef = useRef<ReturnType<typeof setTimeout>>()

  const fetchActivity = useCallback(async () => {
    setLoading(true)
    const since = new Date(Date.now() - range * 60 * 60 * 1000).toISOString()

    // Fetch episodes and usage data in parallel
    const [episodesRes, usageRes] = await Promise.all([
      fetch(`/api/episodes?sort=updated_at&order=desc&limit=500&page=1&since=${since}`),
      fetch(`/api/usage?from=${since}`),
    ])

    if (episodesRes.ok) {
      const data = await episodesRes.json()
      setEntries(data.episodes ?? [])
    }

    if (usageRes.ok) {
      const data = await usageRes.json()
      const map = new Map<number, { cost: number; durationSec: number | null; operation: string }>()
      for (const entry of (data.entries ?? []) as UsageEntry[]) {
        if (entry.episode_id == null) continue
        const existing = map.get(entry.episode_id)
        // Keep the most relevant operation per episode (latest cost entry)
        if (!existing || (Number(entry.estimated_cost) || 0) > existing.cost) {
          map.set(entry.episode_id, {
            cost: Number(entry.estimated_cost) || 0,
            durationSec: entry.duration_seconds,
            operation: entry.operation,
          })
        }
      }
      setUsageMap(map)
    }

    setLoading(false)
  }, [range])

  useEffect(() => { fetchActivity() }, [fetchActivity])

  // Apply client-side filters
  const filtered = useMemo(() => {
    let result = entries
    if (typeFilter) {
      result = result.filter(e => e.status === typeFilter)
    }
    if (showSearch.trim()) {
      const q = showSearch.trim().toLowerCase()
      result = result.filter(e =>
        (e.show_name ?? '').toLowerCase().includes(q) ||
        (e.show_key ?? '').toLowerCase().includes(q)
      )
    }
    return result
  }, [entries, typeFilter, showSearch])

  // Group entries by date
  const grouped = useMemo(() => {
    const map = new Map<string, ActivityEntry[]>()
    for (const entry of filtered) {
      const day = entry.updated_at.slice(0, 10)
      const list = map.get(day) ?? []
      list.push(entry)
      map.set(day, list)
    }
    return map
  }, [filtered])

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  function formatDay(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00')
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (dateStr === today) return 'TODAY'
    if (dateStr === yesterday) return 'YESTERDAY'
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase()
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${Math.round(seconds)}s`
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  }

  function formatCost(cost: number): string {
    if (cost < 0.01) return `$${cost.toFixed(4)}`
    return `$${cost.toFixed(2)}`
  }

  function handleRangeChange(hours: number) {
    setRange(hours)
    updateUrl(hours, typeFilter, showSearch)
  }

  function handleTypeChange(value: string) {
    setTypeFilter(value)
    updateUrl(range, value, showSearch)
  }

  function handleShowChange(value: string) {
    setShowSearch(value)
    clearTimeout(showDebounceRef.current)
    showDebounceRef.current = setTimeout(() => {
      updateUrl(range, typeFilter, value)
    }, 350)
  }

  // Render right-column metadata based on episode status
  function renderMeta(entry: ActivityEntry) {
    const usage = usageMap.get(entry.id)

    if (entry.status === 'transcribed' && usage?.durationSec != null) {
      return (
        <span className="text-xs text-blue-500 font-medium shrink-0">
          {formatDuration(usage.durationSec)}
        </span>
      )
    }

    if (entry.status === 'summarized' && usage) {
      return (
        <span className="text-xs text-emerald-500 font-medium shrink-0">
          {formatCost(usage.cost)}
        </span>
      )
    }

    if (entry.status === 'pending' && entry.duration) {
      return (
        <span className="text-xs text-amber-500 font-medium shrink-0">
          {entry.duration} min
        </span>
      )
    }

    return null
  }

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header + Range */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold dark:text-warm-100">Activity Log</h2>
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => handleRangeChange(opt.hours)}
              className={`px-3 py-1.5 text-xs rounded-md ${
                range === opt.hours
                  ? 'bg-gray-900 text-white dark:bg-warm-200 dark:text-warm-900'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-warm-700 dark:text-warm-300 dark:hover:bg-warm-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Event type filter pills */}
        <div className="flex gap-1">
          {EVENT_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => handleTypeChange(f.value)}
              className={`px-3 py-1.5 text-xs rounded-md ${
                typeFilter === f.value
                  ? 'bg-gray-900 text-white dark:bg-warm-200 dark:text-warm-900'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-warm-700 dark:text-warm-300 dark:hover:bg-warm-600'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Show name search */}
        <div className="flex-1 min-w-[200px] max-w-xs">
          <input
            type="text"
            placeholder="Search show name..."
            value={showSearch}
            onChange={(e) => handleShowChange(e.target.value)}
            className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-gray-300 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100 dark:placeholder-warm-500 dark:focus:ring-warm-500"
          />
        </div>

        {/* Result count */}
        {!loading && (
          <span className="text-xs text-gray-400 dark:text-warm-500">
            {filtered.length} event{filtered.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <SkeletonBlock />
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500 dark:bg-surface-raised dark:text-warm-400">
          No activity{typeFilter ? ` with status "${typeFilter}"` : ''}{showSearch ? ` matching "${showSearch}"` : ''} in this time range.
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([day, dayEntries]) => (
            <div key={day}>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 sticky top-0 bg-gray-50 py-1 px-1 -mx-1 rounded dark:text-warm-500 dark:bg-surface">
                {formatDay(day)} — {dayEntries.length} event{dayEntries.length !== 1 ? 's' : ''}
              </h3>
              <div className="bg-white rounded-lg shadow divide-y dark:bg-surface-raised dark:shadow-card-dark dark:divide-warm-700">
                {dayEntries.map((entry, i) => (
                  <a
                    key={`${entry.id}-${i}`}
                    href={`/dashboard/episodes/${entry.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors dark:hover:bg-warm-700/50"
                  >
                    <span className="text-xs text-gray-400 w-16 shrink-0 text-right dark:text-warm-500">
                      {formatTime(entry.updated_at)}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${BADGE_COLORS[entry.status] ?? 'bg-gray-100'}`}>
                      {entry.status}
                    </span>
                    <span className="text-sm text-gray-700 truncate flex-1 dark:text-warm-200">
                      {entry.show_name ?? `Episode #${entry.id}`}
                    </span>
                    <span className="text-xs text-gray-400 truncate max-w-[200px] hidden sm:inline dark:text-warm-500">
                      {entry.headline ?? ''}
                    </span>
                    {renderMeta(entry)}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
