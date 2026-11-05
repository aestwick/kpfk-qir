'use client'

// Show report — "what did <show> cover in <period>?" Issue categories, guests,
// hosts and the episode list (headline per episode) for one logical show (all
// its feeds) over a date range. URL holds the state:
//   /dashboard/show-report?show=hartmann&from=2026-10-01&to=2026-10-31

import { useMemo } from 'react'
import Link from 'next/link'
import { useSearchParams, usePathname } from 'next/navigation'
import { useApiJson, useUrlUpdater, ErrorPanel, FindSwitcher, RowsSkeleton, StatusBadge, CARD, INPUT } from '@/app/components/browse-ui'
import {
  formatAirDate,
  formatAirTime,
  formatMinutes,
  isIsoDate,
  episodeMomentHref,
  personHref,
  broadcastDayHref,
  monthRange,
  shiftDate,
  stationToday,
  timeToMinutes,
} from '@/lib/broadcast-format'
import { getCurrentQuarterBounds } from '@/lib/quarters'
import { locationFrom } from '@/lib/nav'
import type { Tally } from '@/lib/show-report'

interface ShowRow {
  key: string
  display: string
  group: string
  active: boolean
}

interface ReportResponse {
  truncated?: boolean
  show: { key: string; name: string; keys: string[]; category: string | null }
  from: string
  to: string
  episodeCount: number
  totalMinutes: number
  pendingCount: number
  issues: Tally[]
  guests: Tally[]
  hosts: Tally[]
  episodes: {
    id: number
    airDate: string | null
    airStart: string | null
    duration: number | null
    headline: string | null
    host: string | null
    guest: string | null
    issueCategory: string | null
    status: string
  }[]
}

function presets(today: string) {
  const thisMonth = monthRange(today)
  const lastMonth = monthRange(shiftDate(thisMonth.from, -1))
  const q = getCurrentQuarterBounds()
  return [
    { label: 'This month', ...thisMonth },
    { label: 'Last month', ...lastMonth },
    { label: 'This quarter', from: q.start, to: q.end },
    { label: 'Last 90 days', from: shiftDate(today, -89), to: today },
  ]
}

function TallyList({ title, items, link, empty }: { title: string; items: Tally[]; link?: (name: string) => string; empty: string }) {
  return (
    <section className={`${CARD} p-4`}>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-warm-400 dark:text-warm-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.slice(0, 15).map((t) => (
            <li key={t.name} className="flex justify-between gap-2">
              {link ? (
                <Link href={link(t.name)} className="truncate text-blue-700 dark:text-blue-400 hover:underline">
                  {t.name}
                </Link>
              ) : (
                <span className="truncate">{t.name}</span>
              )}
              <span className="shrink-0 tabular-nums text-warm-500 dark:text-warm-400">{t.count}</span>
            </li>
          ))}
          {items.length > 15 && <li className="text-xs text-warm-400">+ {items.length - 15} more</li>}
        </ul>
      )}
    </section>
  )
}

export default function ShowReportPage() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const show = searchParams.get('show') ?? ''
  const today = stationToday()
  const month = monthRange(today)
  const from = isIsoDate(searchParams.get('from')) ? searchParams.get('from')! : month.from
  const to = isIsoDate(searchParams.get('to')) ? searchParams.get('to')! : month.to

  const update = useUrlUpdater()

  const shows = useApiJson<{ shows: ShowRow[] }>('/api/shows')
  const options = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; active: boolean }>()
    for (const s of shows.data?.shows ?? []) {
      const g = s.group.toLowerCase()
      const prev = seen.get(g)
      if (!prev) seen.set(g, { key: s.key, label: s.display, active: s.active })
      else if (s.active) prev.active = true
    }
    return Array.from(seen.values()).sort((a, b) => Number(b.active) - Number(a.active) || a.label.localeCompare(b.label))
  }, [shows.data])

  // The URL may name any feed of a show; the dropdown lists one entry per group.
  const selectedKey = useMemo(() => {
    const rows = shows.data?.shows ?? []
    const group = rows.find((r) => r.key === show)?.group.toLowerCase()
    return options.find((o) => rows.find((r) => r.key === o.key)?.group.toLowerCase() === group)?.key ?? show
  }, [shows.data, options, show])

  const url = show ? `/api/show-report?${new URLSearchParams({ show, from, to })}` : null
  const { data, error, loading, reload } = useApiJson<ReportResponse>(url)
  const here = locationFrom(pathname, searchParams.toString())

  return (
    <div className="space-y-4 max-w-5xl">
      <FindSwitcher active="/dashboard/show-report" />
      <div>
        <h2 className="text-2xl font-bold">What a show covered</h2>
        <p className="text-sm text-warm-500 dark:text-warm-400">Topics, issue categories and guests for one show over a period.</p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-warm-500 dark:text-warm-400">
          Show
          <select value={selectedKey} onChange={(e) => update({ show: e.target.value })} className={`${INPUT} mt-1 block w-64 max-w-full`}>
            <option value="">Choose a show…</option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
                {o.active ? '' : ' (not tracked)'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-warm-500 dark:text-warm-400">
          From
          <input type="date" value={from} onChange={(e) => isIsoDate(e.target.value) && update({ from: e.target.value })} className={`${INPUT} mt-1 block`} />
        </label>
        <label className="text-xs text-warm-500 dark:text-warm-400">
          To
          <input type="date" value={to} onChange={(e) => isIsoDate(e.target.value) && update({ to: e.target.value })} className={`${INPUT} mt-1 block`} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets(today).map((p) => (
          <button
            key={p.label}
            onClick={() => update({ from: p.from, to: p.to })}
            className={`rounded-full px-2.5 py-1 text-xs border ${
              p.from === from && p.to === to
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-warm-200 text-warm-600 hover:bg-warm-50 dark:border-warm-700 dark:text-warm-300 dark:hover:bg-warm-700'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {!show ? (
        <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>Choose a show to see what it covered.</div>
      ) : error ? (
        <ErrorPanel message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className={CARD}>
          <RowsSkeleton rows={6} />
        </div>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-xl font-semibold">{data.show.name}</h3>
            <span className="text-sm text-warm-500 dark:text-warm-400">
              {formatAirDate(data.from, { weekday: false })} – {formatAirDate(data.to, { weekday: false })} · {data.episodeCount} episode
              {data.episodeCount === 1 ? '' : 's'} · {formatMinutes(data.totalMinutes)} on air
            </span>
            <Link href={`/dashboard/search?show_key=${encodeURIComponent(data.show.key)}`} className="text-sm text-blue-700 dark:text-blue-400 hover:underline">
              Search inside this show →
            </Link>
          </div>
          {data.truncated && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This range has more episodes than one report can hold — counts cover the earliest part only. Pick a shorter range.
            </p>
          )}
          {data.pendingCount > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {data.pendingCount} episode{data.pendingCount === 1 ? ' is' : 's are'} still being processed, so topics and guests may be incomplete.
            </p>
          )}

          {data.episodeCount === 0 ? (
            <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>
              No episodes of this show aired in this period. Try a wider range.
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <TallyList title="Issue categories" items={data.issues} empty="None tagged yet." />
                <TallyList title="Guests" items={data.guests} link={personHref} empty="No guests recorded." />
                <TallyList title="Hosts" items={data.hosts} link={personHref} empty="No hosts recorded." />
              </div>

              <section className={CARD}>
                <h3 className="px-4 pt-3 text-sm font-semibold">Episodes &amp; topics</h3>
                <ul className="divide-y divide-warm-100 dark:divide-warm-700">
                  {data.episodes.map((e) => {
                    const hour = timeToMinutes(e.airStart)
                    return (
                      <li key={e.id} className="px-4 py-2.5 sm:flex sm:gap-4">
                        <div className="sm:w-36 shrink-0 text-sm">
                          {e.airDate ? (
                            <Link href={broadcastDayHref(e.airDate, hour != null ? Math.floor(hour / 60) : null)} className="hover:underline">
                              {formatAirDate(e.airDate, { year: false })}
                            </Link>
                          ) : (
                            '—'
                          )}
                          <div className="text-xs text-warm-400 dark:text-warm-500">
                            {formatAirTime(e.airStart)} · {formatMinutes(e.duration)}
                          </div>
                        </div>
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <Link href={episodeMomentHref(e.id, null, here)} className="text-sm text-blue-700 dark:text-blue-400 hover:underline">
                            {e.headline || 'Untitled episode'}
                          </Link>
                          <div className="flex flex-wrap gap-x-3 text-xs text-warm-500 dark:text-warm-400">
                            {e.guest && <span>Guest: {e.guest}</span>}
                            {e.issueCategory && <span>{e.issueCategory}</span>}
                            {e.status !== 'compliance_checked' && e.status !== 'summarized' && <StatusBadge status={e.status} />}
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
