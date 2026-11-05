'use client'

// Search — "where was this said?" A quote, a name or a topic → the episodes
// that contain it, each opening the audio at the moment it was said.
//
// Forgiving by default: accents ("movilizacion"), plurals, and likely
// misspellings ("Hartmann" also finds Whisper's "Hartman") are matched, and the
// page says which spellings it added. "By meaning" also finds episodes about
// the topic when the exact words weren't used. Every filter lives in the URL.

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { getQuarterOptions } from '@/lib/quarters'
import { locationFrom } from '@/lib/nav'
import {
  formatAirDate,
  formatAirTime,
  formatOffset,
  formatMomentClock,
  episodeMomentHref,
  broadcastDayHref,
  timeToMinutes,
} from '@/lib/broadcast-format'
import type { TranscriptSearchResult } from '@/lib/types'
import { useApiJson, Highlighted, ErrorPanel, FindSwitcher, RowsSkeleton, StatusBadge, CARD, INPUT, BUTTON } from '@/app/components/browse-ui'

interface SearchResponse {
  results: TranscriptSearchResult[]
  total: number
  alsoMatched: string[]
  relaxed: boolean
  degraded?: boolean
  mode: 'lexical' | 'semantic'
}

interface ShowRow {
  key: string
  display: string
  group: string
}

const LIMIT = 20
/** Matches beyond this are counted but only the most recent are ranked (048). */
const RANK_WINDOW = 200

export default function SearchPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const q = searchParams.get('q') ?? ''
  const showKey = searchParams.get('show_key') ?? ''
  const quarter = searchParams.get('quarter') ?? ''
  const mode = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'
  const page = Math.max(parseInt(searchParams.get('page') ?? '1', 10) || 1, 1)

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  function update(updates: Record<string, string>) {
    const p = new URLSearchParams(searchParams.toString())
    for (const [k, v] of Object.entries(updates)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    router.replace(`${pathname}?${p}`, { scroll: false })
  }

  // Typing updates the URL after a pause; Enter searches immediately.
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  function onType(v: string) {
    setDraft(v)
    clearTimeout(debounce.current)
    debounce.current = setTimeout(() => update({ q: v.trim(), page: '' }), 450)
  }

  const shows = useApiJson<{ shows: ShowRow[] }>('/api/shows')
  const showOptions = useMemo(() => {
    const seen = new Map<string, { key: string; label: string }>()
    for (const s of shows.data?.shows ?? []) if (!seen.has(s.group.toLowerCase())) seen.set(s.group.toLowerCase(), { key: s.key, label: s.display })
    return Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [shows.data])

  const apiUrl = useMemo(() => {
    if (q.trim().length < 2) return null
    const p = new URLSearchParams({ q, page: String(page), limit: String(LIMIT) })
    if (showKey) p.set('show_key', showKey)
    if (quarter) p.set('quarter', quarter)
    if (mode === 'semantic') p.set('mode', 'semantic')
    return `/api/transcript-search?${p}`
  }, [q, page, showKey, quarter, mode])
  const { data, error, loading, reload } = useApiJson<SearchResponse>(apiUrl)

  const from = locationFrom(pathname, searchParams.toString())
  const quarterOptions = getQuarterOptions(6).map((o) => ({ label: o.label, value: `${o.year}-Q${o.quarter}` }))
  const totalPages = data ? Math.ceil(Math.min(data.total, mode === 'lexical' ? RANK_WINDOW : data.total) / LIMIT) : 0

  return (
    <div className="space-y-4 max-w-4xl">
      <FindSwitcher active="/dashboard/search" />
      <div>
        <h2 className="text-2xl font-bold">What was said</h2>
        <p className="text-sm text-warm-500 dark:text-warm-400">
          Type a quote, a name or a topic. Each result opens the audio at the moment it was said.
        </p>
      </div>

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault()
          clearTimeout(debounce.current)
          update({ q: draft.trim(), page: '' })
        }}
      >
        <div className="flex gap-2">
          <input
            type="search"
            autoFocus
            aria-label="Search transcripts"
            placeholder='e.g. Greg Palast · "war on voting" · vivienda'
            value={draft}
            onChange={(e) => onType(e.target.value)}
            className={`${INPUT} w-full`}
          />
          <button type="submit" className={`${BUTTON} shrink-0`}>
            Search
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Show" value={showKey} onChange={(e) => update({ show_key: e.target.value, page: '' })} className={`${INPUT} max-w-[14rem]`}>
            <option value="">All shows</option>
            {showOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select aria-label="When" value={quarter} onChange={(e) => update({ quarter: e.target.value, page: '' })} className={INPUT}>
            <option value="">Any time</option>
            {quarterOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="inline-flex rounded-lg border border-warm-300 dark:border-warm-600 overflow-hidden text-sm" role="group" aria-label="Match">
            {(['lexical', 'semantic'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => update({ mode: m === 'semantic' ? 'semantic' : '', page: '' })}
                className={`px-3 py-2 ${mode === m ? 'bg-blue-600 text-white' : 'bg-white text-warm-700 dark:bg-warm-800 dark:text-warm-300'}`}
                title={m === 'lexical' ? 'The words you typed (forgiving of accents and typos)' : 'Also episodes about this topic, even in other words'}
              >
                {m === 'lexical' ? 'Exact words' : 'By meaning'}
              </button>
            ))}
          </div>
        </div>
        <details className="text-xs text-warm-500 dark:text-warm-400">
          <summary className="cursor-pointer select-none">Search tips</summary>
          <ul className="mt-1 ml-4 list-disc space-y-0.5">
            <li>
              <code>&quot;war on voting&quot;</code> — words in that order
            </li>
            <li>
              <code>housing -rent</code> — leave out episodes that say “rent”
            </li>
            <li>
              <code>eviction OR desalojo</code> — either word
            </li>
            <li>Names are matched forgivingly — “Hartmann” also finds “Hartman”.</li>
          </ul>
        </details>
      </form>

      {/* Status line */}
      {data && !error && (
        <div className="space-y-1 text-sm text-warm-600 dark:text-warm-400">
          <p>
            {data.total === 0 ? (
              'No episodes matched.'
            ) : (
              <>
                <strong className="text-warm-900 dark:text-warm-100">{data.total.toLocaleString()}</strong> episode{data.total === 1 ? '' : 's'}
                {mode === 'lexical' && data.total > RANK_WINDOW && ` — showing the best matches from the ${RANK_WINDOW} most recent. Pick a show or a quarter to reach older ones.`}
              </>
            )}
          </p>
          {data.alsoMatched.length > 0 && (
            <p className="text-xs">
              Also matched: {data.alsoMatched.slice(0, 8).map((w) => <code key={w} className="mr-1 rounded bg-warm-100 px-1 dark:bg-warm-700">{w}</code>)}
            </p>
          )}
          {data.relaxed && <p className="text-xs text-amber-700 dark:text-amber-400">No episode has every word — showing the closest matches.</p>}
          {data.degraded && <p className="text-xs text-amber-700 dark:text-amber-400">Meaning search is unavailable right now — showing exact-word matches.</p>}
        </div>
      )}

      {error ? (
        <ErrorPanel message={error} onRetry={reload} />
      ) : !apiUrl ? (
        <div className={`${CARD} px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400`}>
          Type at least 2 characters. Looking for what aired at a certain time?{' '}
          <Link href="/dashboard/day" className="text-blue-700 dark:text-blue-400 underline">
            Open the day log
          </Link>
          .
        </div>
      ) : (
        <div className={CARD}>
          {loading && !data ? (
            <RowsSkeleton />
          ) : data && data.results.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-warm-500 dark:text-warm-400">
              <p>Nothing matched “{q}”{showKey || quarter ? ' with these filters' : ''}.</p>
              <p className="mt-1">
                {showKey || quarter ? 'Try “All shows” / “Any time”, or ' : 'Try '}
                {mode === 'lexical' ? (
                  <button className="underline" onClick={() => update({ mode: 'semantic', page: '' })}>
                    searching by meaning
                  </button>
                ) : (
                  'fewer words'
                )}
                .
              </p>
            </div>
          ) : (
            <ul className={`divide-y divide-warm-100 dark:divide-warm-700 ${loading ? 'opacity-60' : ''}`}>
              {data?.results.map((r) => {
                const clock = r.startMs != null ? formatMomentClock(r.airStart, r.startMs) : null
                const hour = timeToMinutes(r.airStart)
                return (
                  <li key={r.episodeId} className="px-4 py-3 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                      <Link href={episodeMomentHref(r.episodeId, null, from)} className="font-medium text-blue-700 dark:text-blue-400 hover:underline">
                        {r.showName ?? `Episode ${r.episodeId}`}
                      </Link>
                      {r.airDate && (
                        <Link
                          href={broadcastDayHref(r.airDate, hour != null ? Math.floor(hour / 60) : null)}
                          className="text-warm-500 dark:text-warm-400 hover:underline"
                          title="See the whole day"
                        >
                          {formatAirDate(r.airDate)}
                          {r.airStart && ` · ${formatAirTime(r.airStart)}`}
                        </Link>
                      )}
                      {r.matchType === 'semantic' && (
                        <span className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300" title="Matched by meaning, not exact words">
                          ≈ about this
                        </span>
                      )}
                      {r.status !== 'compliance_checked' && r.status !== 'summarized' && <StatusBadge status={r.status} />}
                    </div>

                    {r.startMs != null ? (
                      <Link
                        href={episodeMomentHref(r.episodeId, r.startMs, from)}
                        className="group flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-2 hover:bg-blue-50 dark:border-blue-500/20 dark:bg-blue-500/10"
                      >
                        <span className="shrink-0 rounded bg-blue-600 px-1.5 py-0.5 text-xs font-semibold text-white tabular-nums">
                          ▶ {formatOffset(r.startMs)}
                        </span>
                        <span className="text-sm text-warm-800 dark:text-warm-200">
                          {r.momentText ? <Highlighted text={r.momentText} /> : <span className="text-warm-500">Play from here</span>}
                          {clock && <span className="ml-1 text-xs text-warm-500 dark:text-warm-400">(aired about {clock})</span>}
                        </span>
                      </Link>
                    ) : (
                      <p className="text-xs text-warm-500 dark:text-warm-400">No timestamp for this one — open the episode to read the transcript.</p>
                    )}

                    {/* The whole-transcript snippet is a fallback: in long episodes it
                        can miss the match (word positions clamp past ~16k words),
                        while the moment line above is always the matching caption. */}
                    {r.snippet && !r.momentText && (
                      <p className="text-sm text-warm-600 dark:text-warm-400">
                        <Highlighted text={r.snippet} />
                      </p>
                    )}
                    {(r.host || r.guest) && (
                      <p className="text-xs text-warm-500 dark:text-warm-400">
                        {r.host && <>Host: {r.host}</>}
                        {r.host && r.guest && ' · '}
                        {r.guest && <>Guest: {r.guest}</>}
                      </p>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button className={BUTTON} disabled={page <= 1} onClick={() => update({ page: page <= 2 ? '' : String(page - 1) })}>
            ← Previous
          </button>
          <span className="text-warm-500">
            Page {page} of {totalPages}
          </span>
          <button className={BUTTON} disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
