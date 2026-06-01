'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { authedFetch } from '@/lib/api-client'
import { createBrowserClient } from '@/lib/supabase'
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUS_BADGE,
  FLAG_TYPE_LABELS,
  flagTypeLabel,
  type ReviewStatus,
} from '@/lib/compliance-status'
import type { SeekToFn } from '@/app/components/episode-media'

/* ─── lazy-loaded audio player (reused from the episode detail page) ─── */
const AudioPlayerWithCaptions = dynamic(
  () => import('@/app/components/episode-media').then((m) => ({ default: m.AudioPlayerWithCaptions })),
  {
    loading: () => (
      <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4">
        <div className="h-24 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" />
      </div>
    ),
    ssr: false,
  }
)

/* ─── shared report shapes (server builds these, the authed refetch returns them too) ─── */
export interface ReportFlag {
  id: number
  flag_type: string
  severity: string
  excerpt: string | null
  details: string | null
  timestamp_seconds: number | null
  review_status: ReviewStatus
  resolved_by: string | null
  resolved_notes: string | null
}

export interface ReportEpisode {
  episode_id: number
  show_name: string
  show_key: string
  air_date: string | null
  air_start: string | null
  duration: number | null
  headline: string | null
  host: string | null
  mp3_url: string | null
  flags: ReportFlag[]
}

export interface ReportShow {
  show_name: string
  show_key: string
  episodes: ReportEpisode[]
  total_flags: number
  critical: number
  warning: number
  info: number
}

// A flag plus the episode/show context it belongs to — the flat unit we filter
// and regroup on the client so type/severity/status filtering is instant.
interface FlatFlag extends ReportFlag {
  episode_id: number
  show_key: string
  show_name: string
  air_date: string | null
  air_start: string | null
  duration: number | null
  headline: string | null
  host: string | null
  mp3_url: string | null
}

const severityColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800/40',
  warning: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/40',
  info: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800/40',
}
const severityPrintColors: Record<string, string> = {
  critical: 'print-severity-critical',
  warning: 'print-severity-warning',
  info: 'print-severity-info',
}
const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
const SEVERITIES = ['critical', 'warning', 'info'] as const
// Meaningful triage targets surfaced as inline buttons (current status excluded).
const TRIAGE_ACTIONS: ReviewStatus[] = ['investigating', 'violation', 'dismissed']

function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Locate an excerpt in raw VTT text → cue start seconds. Mirrors the episode
// detail page so flags without a stored timestamp can still seek to the moment.
function findTimestampInVtt(vtt: string, excerpt: string): number | null {
  if (!vtt) return null
  const needle = excerpt.toLowerCase().slice(0, 80)
  for (const block of vtt.split(/\n\n+/)) {
    const lines = block.trim().split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/)
      if (m) {
        const text = lines.slice(i + 1).join(' ').toLowerCase()
        if (text.includes(needle)) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
      }
    }
  }
  return null
}

function flatten(shows: ReportShow[]): FlatFlag[] {
  const out: FlatFlag[] = []
  for (const show of shows) {
    for (const ep of show.episodes) {
      for (const flag of ep.flags) {
        out.push({
          ...flag,
          episode_id: ep.episode_id,
          show_key: ep.show_key ?? show.show_key,
          show_name: ep.show_name ?? show.show_name,
          air_date: ep.air_date,
          air_start: ep.air_start,
          duration: ep.duration,
          headline: ep.headline,
          host: ep.host,
          mp3_url: ep.mp3_url,
        })
      }
    }
  }
  return out
}

export default function ReportClient({
  stationSlug,
  quarter,
  initialShows,
  initialFilters,
}: {
  stationSlug: string
  quarter: string
  initialShows: ReportShow[]
  initialFilters: { types: string[]; severities: string[]; statuses: ReviewStatus[]; show: string }
}) {
  const [allFlags, setAllFlags] = useState<FlatFlag[]>(() => flatten(initialShows))
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(() => new Set(initialFilters.types))
  const [selectedSeverities, setSelectedSeverities] = useState<Set<string>>(() => new Set(initialFilters.severities))
  const [selectedStatuses, setSelectedStatuses] = useState<Set<ReviewStatus>>(() => new Set(initialFilters.statuses))
  const [showSearch, setShowSearch] = useState(initialFilters.show)

  const [canTriage, setCanTriage] = useState(false)
  const userEmailRef = useRef<string | null>(null)

  const vttCache = useRef<Map<number, string>>(new Map())
  const seekFns = useRef<Map<number, SeekToFn>>(new Map())
  const [openEpisode, setOpenEpisode] = useState<number | null>(null)
  const [firstSeek, setFirstSeek] = useState(0)
  const [loadingEpisode, setLoadingEpisode] = useState<number | null>(null)

  const [busyFlag, setBusyFlag] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // On mount: if the viewer is signed in, unlock triage and pull the *full*
  // flag set (all review statuses, quarter-scoped) so status filtering and
  // suggestions work in-page. Anonymous/print viewers keep the server payload
  // (active offenses only), so AI suggestions are never exposed publicly.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createBrowserClient()
        const { data: { session } } = await supabase.auth.getSession()
        if (cancelled || !session) return
        setCanTriage(true)
        userEmailRef.current = session.user?.email ?? null
        const params = new URLSearchParams({ status: REVIEW_STATUSES.join(',') })
        if (quarter) params.set('quarter', quarter)
        const res = await authedFetch(`/api/compliance/report?${params.toString()}`, {
          headers: { 'x-station-slug': stationSlug },
        })
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (Array.isArray(data.shows)) {
          setAllFlags(flatten(data.shows as ReportShow[]))
        }
      } catch {
        /* leave the server payload in place */
      }
    })()
    return () => { cancelled = true }
  }, [quarter, stationSlug])

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  // Counts across the whole loaded set (so chips show totals regardless of the
  // current selection).
  const { typeCounts, statusCounts, severityCounts } = useMemo(() => {
    const types = new Map<string, number>()
    const statuses = new Map<string, number>()
    const sevs = new Map<string, number>()
    for (const f of allFlags) {
      types.set(f.flag_type, (types.get(f.flag_type) ?? 0) + 1)
      statuses.set(f.review_status, (statuses.get(f.review_status) ?? 0) + 1)
      sevs.set(f.severity, (sevs.get(f.severity) ?? 0) + 1)
    }
    return { typeCounts: types, statusCounts: statuses, severityCounts: sevs }
  }, [allFlags])

  // Apply filters → regroup into shows → compute summary.
  const { shows, summary } = useMemo(() => {
    const search = showSearch.trim().toLowerCase()
    const filtered = allFlags.filter(
      (f) =>
        (selectedTypes.size === 0 || selectedTypes.has(f.flag_type)) &&
        (selectedSeverities.size === 0 || selectedSeverities.has(f.severity)) &&
        (selectedStatuses.size === 0 || selectedStatuses.has(f.review_status)) &&
        (search === '' || (f.show_name ?? '').toLowerCase().includes(search))
    )

    const showMap = new Map<string, ReportShow>()
    for (const f of filtered) {
      const key = f.show_key
      if (!showMap.has(key)) {
        showMap.set(key, { show_name: f.show_name ?? key, show_key: key, episodes: [], total_flags: 0, critical: 0, warning: 0, info: 0 })
      }
      const sg = showMap.get(key)!
      sg.total_flags++
      if (f.severity === 'critical') sg.critical++
      else if (f.severity === 'warning') sg.warning++
      else sg.info++

      let ep = sg.episodes.find((e) => e.episode_id === f.episode_id)
      if (!ep) {
        ep = {
          episode_id: f.episode_id,
          show_name: f.show_name ?? key,
          show_key: key,
          air_date: f.air_date,
          air_start: f.air_start,
          duration: f.duration,
          headline: f.headline,
          host: f.host,
          mp3_url: f.mp3_url,
          flags: [],
        }
        sg.episodes.push(ep)
      }
      ep.flags.push(f)
    }

    const grouped = Array.from(showMap.values())
      .map((s) => ({
        ...s,
        episodes: s.episodes
          .map((ep) => ({ ...ep, flags: [...ep.flags].sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)) }))
          .sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? '')),
      }))
      .sort((a, b) => (a.critical !== b.critical ? b.critical - a.critical : b.total_flags - a.total_flags))

    return {
      shows: grouped,
      summary: {
        total: filtered.length,
        shows: grouped.length,
        episodes: grouped.reduce((n, s) => n + s.episodes.length, 0),
        critical: grouped.reduce((n, s) => n + s.critical, 0),
        warning: grouped.reduce((n, s) => n + s.warning, 0),
        info: grouped.reduce((n, s) => n + s.info, 0),
      },
    }
  }, [allFlags, selectedTypes, selectedSeverities, selectedStatuses, showSearch])

  function toggleValue<T extends string>(set: Set<T>, value: T): Set<T> {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const resetFilters = useCallback(() => {
    setSelectedTypes(new Set())
    setSelectedSeverities(new Set())
    setSelectedStatuses(new Set())
    setShowSearch('')
  }, [])

  const ensureVtt = useCallback(async (episodeId: number): Promise<string> => {
    const cached = vttCache.current.get(episodeId)
    if (cached !== undefined) return cached
    let vtt = ''
    setLoadingEpisode(episodeId)
    try {
      const res = await authedFetch(`/api/episodes/${episodeId}`, { headers: { 'x-station-slug': stationSlug } })
      if (res.ok) {
        const d = await res.json()
        vtt = d.transcript?.vtt ?? ''
      }
    } catch {
      /* no captions available — audio still plays */
    } finally {
      setLoadingEpisode(null)
    }
    vttCache.current.set(episodeId, vtt)
    return vtt
  }, [stationSlug])

  const handleListen = useCallback(
    async (flag: ReportFlag, episodeId: number) => {
      const vtt = await ensureVtt(episodeId)
      const seek =
        flag.timestamp_seconds ?? (flag.excerpt ? findTimestampInVtt(vtt, flag.excerpt) : null) ?? 0
      const existing = seekFns.current.get(episodeId)
      if (openEpisode === episodeId && existing) {
        existing(seek)
      } else {
        setFirstSeek(seek)
        setOpenEpisode(episodeId)
      }
    },
    [ensureVtt, openEpisode]
  )

  const triage = useCallback(
    async (flag: ReportFlag, status: ReviewStatus) => {
      setBusyFlag(flag.id)
      try {
        const res = await authedFetch('/api/compliance', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-station-slug': stationSlug },
          body: JSON.stringify({ id: flag.id, review_status: status, resolved_by: userEmailRef.current ?? 'compliance-report' }),
        })
        if (res.ok) {
          setAllFlags((prev) =>
            prev.map((f) => (f.id === flag.id ? { ...f, review_status: status, resolved_by: userEmailRef.current ?? f.resolved_by } : f))
          )
          setNotice(`${flagTypeLabel(flag.flag_type)} → ${REVIEW_STATUS_LABELS[status]}`)
        } else if (res.status === 403) {
          setNotice('You need editor access to change flag status.')
        } else {
          setNotice('Failed to update flag.')
        }
      } catch {
        setNotice('Failed to update flag.')
      } finally {
        setBusyFlag(null)
      }
    },
    [stationSlug]
  )

  const typeOrder = useMemo(() => {
    const known = Object.keys(FLAG_TYPE_LABELS).filter((t) => typeCounts.has(t))
    const unknown = Array.from(typeCounts.keys()).filter((t) => !(t in FLAG_TYPE_LABELS))
    return [...known, ...unknown]
  }, [typeCounts])

  const filtersActive =
    selectedTypes.size > 0 || selectedSeverities.size > 0 || selectedStatuses.size > 0 || showSearch.trim() !== ''

  const chip = (active: boolean) =>
    `px-2.5 py-1 rounded-full text-xs font-medium border transition-colors capitalize ${
      active
        ? 'bg-blue-600 text-white border-blue-600'
        : 'bg-white dark:bg-warm-800 text-gray-600 dark:text-warm-300 border-gray-300 dark:border-warm-600 hover:border-gray-400 dark:hover:border-warm-500'
    }`

  return (
    <>
      {/* Toolbar / filters — never printed */}
      <section className="no-print mb-6 border dark:border-warm-700 rounded-lg p-4 space-y-3 bg-gray-50/60 dark:bg-warm-800/40">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-600 dark:text-warm-400">Filters</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500 dark:text-warm-500">{summary.total} of {allFlags.length} flags</span>
            {filtersActive && (
              <button onClick={resetFilters} className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400">Reset</button>
            )}
          </div>
        </div>

        {/* Offense type */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 dark:text-warm-400 w-16">Type</span>
          {typeOrder.length === 0 && <span className="text-xs text-gray-400">none</span>}
          {typeOrder.map((t) => (
            <button key={t} onClick={() => setSelectedTypes(toggleValue(selectedTypes, t))} className={chip(selectedTypes.has(t))}>
              {flagTypeLabel(t)} <span className="opacity-70">{typeCounts.get(t)}</span>
            </button>
          ))}
        </div>

        {/* Severity */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 dark:text-warm-400 w-16">Severity</span>
          {SEVERITIES.filter((s) => severityCounts.has(s)).map((s) => (
            <button key={s} onClick={() => setSelectedSeverities(toggleValue(selectedSeverities, s))} className={chip(selectedSeverities.has(s))}>
              {s} <span className="opacity-70">{severityCounts.get(s)}</span>
            </button>
          ))}
        </div>

        {/* Review status */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 dark:text-warm-400 w-16">Status</span>
          {REVIEW_STATUSES.map((s) => (
            <button key={s} onClick={() => setSelectedStatuses(toggleValue(selectedStatuses, s))} className={chip(selectedStatuses.has(s))}>
              {REVIEW_STATUS_LABELS[s]} <span className="opacity-70">{statusCounts.get(s) ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Show search */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-gray-500 dark:text-warm-400 w-16">Show</span>
          <input
            type="text"
            value={showSearch}
            onChange={(e) => setShowSearch(e.target.value)}
            placeholder="Filter by show name…"
            className="border dark:border-warm-600 rounded px-2 py-1 text-sm w-64 dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
          />
        </div>

        {!canTriage && (
          <p className="text-xs text-gray-500 dark:text-warm-500 pt-1 border-t dark:border-warm-700">
            Showing confirmed offenses only. <span className="font-medium">Sign in</span> to review AI suggestions and triage flags inline.
          </p>
        )}
      </section>

      {notice && (
        <div className="no-print mb-4 text-sm px-3 py-2 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 border border-blue-200 dark:border-blue-800/40">
          {notice}
        </div>
      )}

      {/* Summary */}
      <section className="mb-8 border dark:border-warm-700 rounded-lg overflow-hidden">
        <div className="bg-gray-50 dark:bg-warm-800 px-5 py-3 border-b dark:border-warm-700">
          <h2 className="text-sm font-bold uppercase tracking-wide text-gray-600 dark:text-warm-400">Summary</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x dark:divide-warm-700">
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold">{summary.total}</p><p className="text-xs text-gray-500 dark:text-warm-400">Total Flags</p></div>
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold">{summary.shows}</p><p className="text-xs text-gray-500 dark:text-warm-400">Shows</p></div>
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold">{summary.episodes}</p><p className="text-xs text-gray-500 dark:text-warm-400">Episodes</p></div>
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold text-red-600 dark:text-red-400">{summary.critical}</p><p className="text-xs text-gray-500 dark:text-warm-400">Critical</p></div>
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{summary.warning}</p><p className="text-xs text-gray-500 dark:text-warm-400">Warning</p></div>
          <div className="px-4 py-3 text-center"><p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{summary.info}</p><p className="text-xs text-gray-500 dark:text-warm-400">Info</p></div>
        </div>
      </section>

      {shows.length === 0 && (
        <div className="text-center py-16 text-gray-400 dark:text-warm-500">
          <p className="text-lg">No compliance flags match these filters.</p>
        </div>
      )}

      {shows.map((show) => (
        <section key={show.show_key} className="report-show mb-8">
          <div className="flex items-baseline justify-between border-b-2 border-gray-800 dark:border-warm-400 pb-1 mb-4">
            <h3 className="text-lg font-bold uppercase">{show.show_name}</h3>
            <span className="text-xs text-gray-500 dark:text-warm-500">
              {show.total_flags} flag{show.total_flags !== 1 ? 's' : ''}
              {show.critical > 0 && <span className="text-red-600 dark:text-red-400 ml-2">{show.critical} critical</span>}
              {show.warning > 0 && <span className="text-amber-600 dark:text-amber-400 ml-2">{show.warning} warning</span>}
            </span>
          </div>

          {show.episodes.map((ep) => (
            <div key={ep.episode_id} className="report-entry mb-5 ml-2">
              <div className="mb-2">
                <p className="font-semibold text-sm">
                  {ep.air_date ?? 'Unknown date'}
                  {ep.air_start && <span className="text-gray-500 dark:text-warm-400"> at {ep.air_start}</span>}
                  {ep.duration && <span className="text-gray-500 dark:text-warm-400"> ({ep.duration} min)</span>}
                </p>
                {ep.headline && <p className="text-sm text-gray-600 dark:text-warm-400">{ep.headline}</p>}
                {ep.host && <p className="text-xs text-gray-500 dark:text-warm-500">Host: {ep.host}</p>}
              </div>

              <div className="border dark:border-warm-700 rounded-lg overflow-hidden ml-2">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 dark:bg-warm-800">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-24">Severity</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-32">Type</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-24">Time</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Excerpt / Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-warm-700">
                    {ep.flags.map((flag) => (
                      <tr key={flag.id} className={severityPrintColors[flag.severity] ?? ''}>
                        <td className="px-3 py-2 align-top">
                          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium severity-badge ${severityColors[flag.severity] ?? ''}`}>
                            {flag.severity}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-700 dark:text-warm-300 align-top">{flagTypeLabel(flag.flag_type)}</td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-1">
                            <span className="text-xs font-mono text-gray-500 dark:text-warm-400">
                              {flag.timestamp_seconds != null ? formatTimestamp(flag.timestamp_seconds) : '--'}
                            </span>
                            {ep.mp3_url && (
                              <button
                                onClick={() => handleListen(flag, ep.episode_id)}
                                disabled={loadingEpisode === ep.episode_id}
                                title="Play this moment in the audio"
                                className="no-print text-xs px-1.5 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                              >
                                {loadingEpisode === ep.episode_id ? '…' : '▶'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {flag.excerpt && <p className="text-sm text-gray-800 dark:text-warm-200">&ldquo;{flag.excerpt}&rdquo;</p>}
                          {flag.details && <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5">{flag.details}</p>}
                          <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                            <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${REVIEW_STATUS_BADGE[flag.review_status]}`}>
                              {REVIEW_STATUS_LABELS[flag.review_status]}
                            </span>
                            {canTriage &&
                              TRIAGE_ACTIONS.filter((s) => s !== flag.review_status).map((s) => (
                                <button
                                  key={s}
                                  onClick={() => triage(flag, s)}
                                  disabled={busyFlag === flag.id}
                                  className="no-print text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-warm-600 text-gray-600 dark:text-warm-300 hover:bg-gray-100 dark:hover:bg-warm-700 disabled:opacity-50"
                                >
                                  {REVIEW_STATUS_LABELS[s]}
                                </button>
                              ))}
                          </div>
                          {flag.resolved_notes && (
                            <p className="text-xs italic text-gray-500 dark:text-warm-500 mt-1">
                              Note: {flag.resolved_notes}{flag.resolved_by ? ` — ${flag.resolved_by}` : ''}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {openEpisode === ep.episode_id && ep.mp3_url && (
                <div className="no-print mt-3 ml-2">
                  <AudioPlayerWithCaptions
                    key={ep.episode_id}
                    mp3Url={ep.mp3_url}
                    vtt={vttCache.current.get(ep.episode_id) ?? ''}
                    initialSeek={firstSeek}
                    onReady={(fn) => { seekFns.current.set(ep.episode_id, fn) }}
                  />
                  <button onClick={() => setOpenEpisode(null)} className="mt-1 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400">
                    Close player
                  </button>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
