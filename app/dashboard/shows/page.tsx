'use client'

import { useEffect, useMemo, useState } from 'react'
import { authedFetch } from '@/lib/api-client'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { useNavAccess } from '@/app/components/nav-access'
import { roleAllows } from '@/lib/nav'

/**
 * Shows — a directory of the station's programs, so "my show" is one click from
 * the menu instead of being reachable only by clicking a name in the Episodes
 * table. Each row opens the existing per-show page (/dashboard/shows/<key>).
 * Tracking (which shows we process) is managed in Settings → Shows.
 */

interface ShowRow {
  key: string
  display: string
  group: string
  category: string | null
  active: boolean
}

interface ShowGroupRow {
  group: string
  name: string
  keys: string[]
  category: string | null
  active: boolean
}

export default function ShowsPage() {
  const { role } = useNavAccess()
  const [rows, setRows] = useState<ShowRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [showUntracked, setShowUntracked] = useState(false)

  useEffect(() => {
    authedFetch('/api/shows')
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
        return res.json()
      })
      .then((d) => setRows(d.shows ?? []))
      .catch((e) => setError(e.message || 'Could not load shows'))
  }, [])

  // One row per logical show: a show that airs on several feeds (e.g. a 6am and
  // a 9am airing) is grouped by show_group, never by name.
  const groups = useMemo<ShowGroupRow[]>(() => {
    const map = new Map<string, ShowGroupRow>()
    for (const r of rows ?? []) {
      const id = r.group.toLowerCase()
      const g = map.get(id)
      if (g) {
        g.keys.push(r.key)
        g.active = g.active || r.active
        if (r.active && !g.category) g.category = r.category
      } else {
        map.set(id, { group: r.group, name: r.display || r.key, keys: [r.key], category: r.category, active: r.active })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [rows])

  const q = filter.trim().toLowerCase()
  const visible = groups.filter(
    (g) => (showUntracked || g.active) && (!q || g.name.toLowerCase().includes(q) || g.keys.some((k) => k.includes(q))),
  )
  const untrackedCount = groups.filter((g) => !g.active).length

  return (
    <div className="space-y-5 max-w-4xl">
      <Breadcrumbs />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-warm-900 dark:text-warm-100">Shows</h1>
          <p className="text-sm text-warm-500 dark:text-warm-400 mt-1">
            Our programs. Open one to see everything it aired.
          </p>
        </div>
        {roleAllows(role, 'editor') && (
          <a
            href="/dashboard/settings?tab=shows"
            className="text-sm text-warm-600 dark:text-warm-300 hover:text-kpfk-red underline-offset-2 hover:underline"
          >
            Manage which shows we track →
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Find a show…"
          aria-label="Find a show"
          className="w-full sm:w-72 rounded-lg border border-warm-200 dark:border-warm-700 bg-white dark:bg-surface-raised px-3 py-2 text-sm focus:outline-none focus:border-kpfk-gold"
        />
        {untrackedCount > 0 && (
          <label className="flex items-center gap-2 text-sm text-warm-500 dark:text-warm-400">
            <input type="checkbox" checked={showUntracked} onChange={(e) => setShowUntracked(e.target.checked)} />
            Include {untrackedCount} {untrackedCount === 1 ? 'show' : 'shows'} we don’t track
          </label>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!rows && !error && <p className="text-sm text-warm-400">Loading shows…</p>}

      {rows && (
        <ul className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 divide-y divide-warm-100 dark:divide-warm-800">
          {visible.length === 0 && <li className="px-4 py-6 text-sm text-warm-400">No shows match.</li>}
          {visible.map((g) => (
            <li key={g.group}>
              <a
                href={`/dashboard/shows/${encodeURIComponent(g.keys[0])}`}
                className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-warm-50 dark:hover:bg-warm-800/40"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-warm-800 dark:text-warm-100 truncate">{g.name}</span>
                  {g.keys.length > 1 && (
                    <span className="block text-2xs text-warm-400">{g.keys.length} airings/feeds</span>
                  )}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {g.category && <span className="text-2xs text-warm-400">{g.category}</span>}
                  {!g.active && (
                    <span className="text-2xs px-1.5 py-0.5 rounded bg-warm-100 dark:bg-warm-800 text-warm-500">not tracked</span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
