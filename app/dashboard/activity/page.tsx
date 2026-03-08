'use client'

import { useEffect, useState, useCallback } from 'react'
import { SkeletonBlock } from '@/app/components/skeleton'

interface ActivityEntry {
  id: number
  show_name: string | null
  status: string
  updated_at: string
  air_date: string | null
  headline: string | null
}

const BADGE_COLORS: Record<string, string> = {
  pending:     'bg-amber-100 text-amber-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized:  'bg-emerald-100 text-emerald-800',
  failed:      'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
  dead:        'bg-gray-200 text-gray-700',
}

const RANGE_OPTIONS = [
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
  { label: '30 days', hours: 720 },
]

export default function ActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState(168) // 7 days default

  const fetchActivity = useCallback(async () => {
    setLoading(true)
    const since = new Date(Date.now() - range * 60 * 60 * 1000).toISOString()
    const res = await fetch(`/api/episodes?sort=updated_at&order=desc&limit=500&page=1&since=${since}`)
    if (res.ok) {
      const data = await res.json()
      setEntries(data.episodes ?? [])
    }
    setLoading(false)
  }, [range])

  useEffect(() => { fetchActivity() }, [fetchActivity])

  // Group entries by date
  const grouped = new Map<string, ActivityEntry[]>()
  for (const entry of entries) {
    const day = entry.updated_at.slice(0, 10)
    const list = grouped.get(day) ?? []
    list.push(entry)
    grouped.set(day, list)
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  }

  function formatDay(dateStr: string) {
    const d = new Date(dateStr + 'T12:00:00')
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    if (dateStr === today) return 'Today'
    if (dateStr === yesterday) return 'Yesterday'
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Activity Log</h2>
        <div className="flex gap-1">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setRange(opt.hours)}
              className={`px-3 py-1.5 text-xs rounded-md ${
                range === opt.hours
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <SkeletonBlock />
      ) : entries.length === 0 ? (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          No activity in this time range.
        </div>
      ) : (
        <div className="space-y-6">
          {Array.from(grouped.entries()).map(([day, dayEntries]) => (
            <div key={day}>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 sticky top-0 bg-gray-50 py-1 px-1 -mx-1 rounded">
                {formatDay(day)} — {dayEntries.length} events
              </h3>
              <div className="bg-white rounded-lg shadow divide-y">
                {dayEntries.map((entry, i) => (
                  <a
                    key={`${entry.id}-${i}`}
                    href={`/dashboard/episodes/${entry.id}`}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
                  >
                    <span className="text-xs text-gray-400 w-16 shrink-0 text-right">
                      {formatTime(entry.updated_at)}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${BADGE_COLORS[entry.status] ?? 'bg-gray-100'}`}>
                      {entry.status}
                    </span>
                    <span className="text-sm text-gray-700 truncate flex-1">
                      {entry.show_name ?? `Episode #${entry.id}`}
                    </span>
                    <span className="text-xs text-gray-400 truncate max-w-[200px]">
                      {entry.headline ?? ''}
                    </span>
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
