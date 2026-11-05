'use client'

// Broadcast Day — "what aired on <date> at <time>?" in a couple of clicks.
// Pick a date (station-local), read the day's log in air order, jump to an
// hour. The URL holds the state (?date=2026-10-09&at=07:00) so a link can be
// bookmarked or pasted into an email.

import { useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import {
  useApiJson,
  StatusBadge,
  ErrorPanel,
  FindSwitcher,
  RowsSkeleton,
  CARD,
  INPUT,
  BUTTON,
} from '@/app/components/browse-ui'
import {
  formatAirDate,
  formatAirTime,
  formatMinutes,
  isIsoDate,
  episodeMomentHref,
  personHref,
  showReportHref,
  monthRange,
  timeToMinutes,
} from '@/lib/broadcast-format'
import { blockAt, type DayBlock } from '@/lib/broadcast-day'
import { locationFrom } from '@/lib/nav'
import { splitPeople } from '@/lib/people'

interface DayResponse {
  date: string
  timezone: string
  today: string
  prevDate: string
  nextDate: string
  blocks: DayBlock[]
}

const JUMPS = [
  { label: 'Midnight', at: '00:00' },
  { label: '6 AM', at: '06:00' },
  { label: '9 AM', at: '09:00' },
  { label: 'Noon', at: '12:00' },
  { label: '3 PM', at: '15:00' },
  { label: '6 PM', at: '18:00' },
  { label: '9 PM', at: '21:00' },
]

function People({ value, role }: { value: string | null; role: string }) {
  const names = splitPeople(value)
  if (!value) return null
  return (
    <span className="text-warm-600 dark:text-warm-300">
      <span className="text-warm-400 dark:text-warm-500">{role}: </span>
      {names.length
        ? names.map((n, i) => (
            <span key={n}>
              {i > 0 && ', '}
              <Link href={personHref(n)} className="hover:underline">
                {n}
              </Link>
            </span>
          ))
        : value}
    </span>
  )
}

export default function BroadcastDayPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const dateParam = searchParams.get('date')
  const at = searchParams.get('at')
  const date = isIsoDate(dateParam) ? dateParam : null

  const { data, error, loading, reload } = useApiJson<DayResponse>(`/api/broadcast-day${date ? `?date=${date}` : ''}`)
  const shownDate = data?.date ?? date

  function go(params: { date?: string | null; at?: string | null }) {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(params)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    router.replace(`${pathname}?${p}`, { scroll: false })
  }

  // Scroll to (and highlight) the block on air at ?at=HH:MM.
  const focusIdx = useMemo(() => {
    const m = timeToMinutes(at)
    if (!data || m == null) return -1
    return blockAt(data.blocks, m)
  }, [data, at])
  const rowRefs = useRef<Map<number, HTMLLIElement>>(new Map())
  useEffect(() => {
    if (focusIdx < 0 || !data) return
    const el = rowRefs.current.get(data.blocks[focusIdx].episodeId)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [focusIdx, data])

  const from = locationFrom(pathname, searchParams.toString())
  const month = shownDate ? monthRange(shownDate) : null
  const primary = data?.blocks.filter((b) => !b.secondaryFeed).length ?? 0

  return (
    <div className="space-y-4 max-w-4xl">
      <FindSwitcher active="/dashboard/day" />
      <div>
        <h2 className="text-2xl font-bold">What aired</h2>
        <p className="text-sm text-warm-500 dark:text-warm-400">
          The day&apos;s log in air order, in station time ({data?.timezone?.replace('America/', '').replace('_', ' ') ?? 'Los Angeles'}).
        </p>
      </div>

      {/* Date controls */}
      <div className="flex flex-wrap items-center gap-2">
        <button className={BUTTON} onClick={() => data && go({ date: data.prevDate })} aria-label="Previous day" disabled={!data}>
          ←
        </button>
        <input
          type="date"
          aria-label="Date"
          value={shownDate ?? ''}
          onChange={(e) => isIsoDate(e.target.value) && go({ date: e.target.value })}
          className={INPUT}
        />
        <button className={BUTTON} onClick={() => data && go({ date: data.nextDate })} aria-label="Next day" disabled={!data}>
          →
        </button>
        {data && data.date !== data.today && (
          <button className={BUTTON} onClick={() => go({ date: data.today, at: null })}>
            Today
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" aria-label="Jump to a time">
        {JUMPS.map((j) => (
          <button
            key={j.at}
            onClick={() => go({ at: j.at })}
            className={`rounded-full px-2.5 py-1 text-xs border ${
              at === j.at
                ? 'bg-blue-600 text-white border-blue-600'
                : 'border-warm-200 text-warm-600 hover:bg-warm-50 dark:border-warm-700 dark:text-warm-300 dark:hover:bg-warm-700'
            }`}
          >
            {j.label}
          </button>
        ))}
      </div>

      {shownDate && (
        <h3 className="text-lg font-semibold">
          {formatAirDate(shownDate)}
          {data && (
            <span className="ml-2 text-sm font-normal text-warm-500 dark:text-warm-400">
              {primary} program{primary === 1 ? '' : 's'}
            </span>
          )}
        </h3>
      )}

      {error ? (
        <ErrorPanel message={error} onRetry={reload} />
      ) : (
        <div className={CARD}>
          {loading && !data ? (
            <RowsSkeleton rows={8} />
          ) : !data ? null : data.blocks.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400">
              <p className="font-medium text-warm-700 dark:text-warm-200">Nothing logged for {formatAirDate(data.date, { weekday: false })}.</p>
              <p className="mt-1">
                {data.date > data.today
                  ? 'That date hasn’t happened yet.'
                  : 'Either the archive has no recordings for this day, or they haven’t been ingested yet.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-warm-100 dark:divide-warm-700">
              {data.blocks.map((b, i) => (
                <li
                  key={b.episodeId}
                  ref={(el) => {
                    if (el) rowRefs.current.set(b.episodeId, el)
                  }}
                  className={`px-4 py-3 sm:flex sm:gap-4 ${i === focusIdx ? 'bg-blue-50 dark:bg-blue-500/10 ring-1 ring-inset ring-blue-300 dark:ring-blue-500/40' : ''} ${
                    b.secondaryFeed ? 'opacity-70' : ''
                  }`}
                >
                  <div className="sm:w-28 shrink-0 text-sm tabular-nums">
                    <div className="font-semibold">{formatAirTime(b.airStart)}</div>
                    <div className="text-xs text-warm-400 dark:text-warm-500">{formatMinutes(b.durationMin)}</div>
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link
                        href={month ? showReportHref(b.showKey, month.from, month.to) : '#'}
                        className="font-medium text-blue-700 dark:text-blue-400 hover:underline"
                        title="What this show covered this month"
                      >
                        {b.showName}
                      </Link>
                      <StatusBadge status={b.status} />
                      {b.secondaryFeed && (
                        <span className="text-[11px] rounded px-1.5 py-0.5 bg-warm-100 text-warm-600 dark:bg-warm-700 dark:text-warm-300">online feed copy</span>
                      )}
                      {b.issueCategory && <span className="text-xs text-warm-500 dark:text-warm-400">{b.issueCategory}</span>}
                    </div>
                    {b.headline && <p className="text-sm text-warm-800 dark:text-warm-200">{b.headline}</p>}
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                      <People value={b.host} role="Host" />
                      <People value={b.guest} role="Guest" />
                    </div>
                    <div className="flex flex-wrap gap-3 pt-1 text-xs font-medium">
                      <Link href={episodeMomentHref(b.episodeId, null, from)} className="text-blue-700 dark:text-blue-400 hover:underline">
                        Episode &amp; transcript
                      </Link>
                      {b.mp3Url && (
                        <a href={b.mp3Url} target="_blank" rel="noreferrer" className="text-blue-700 dark:text-blue-400 hover:underline">
                          ▶ Audio
                        </a>
                      )}
                      {b.alsoAired.length > 0 && (
                        <span className="text-warm-500 dark:text-warm-400 font-normal">
                          also logged as{' '}
                          {b.alsoAired.map((id, k) => (
                            <span key={id}>
                              {k > 0 && ', '}
                              <Link href={episodeMomentHref(id, null, from)} className="hover:underline">
                                #{id}
                              </Link>
                            </span>
                          ))}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
