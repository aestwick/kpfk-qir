'use client'

// Grid-wide, multi-scope search. Pick what to search — transcript text,
// episode summaries, episode metadata, the station's shows, or All of them at
// once — and (for transcripts) jump straight to the audio at the matched cue.
// Pre-fill ?show_key / ?quarter / ?scope to land scoped. Transcript ranking +
// snippets come from the search RPCs; the other scopes are ilike scans
// (lib/search) highlighted client-side here.

import { useEffect, useState, useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api-client'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { getQuarterOptions, getCurrentQuarter } from '@/lib/quarters'

interface TranscriptResult {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string | null
  status: string
  rank: number
  snippet: string
  startMs: number | null
  matchType?: 'lexical' | 'semantic'
}
interface SummaryResult {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string | null
  status: string
  snippet: string
}
interface EpisodeResult {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string | null
  status: string
  headline: string | null
  host: string | null
  guest: string | null
  category: string | null
}
interface ShowResult {
  key: string
  display: string
  category: string | null
  active: boolean
}
interface Section<T> {
  results: T[]
  total: number
  degraded?: boolean
}
interface SearchResponse {
  scope: Scope
  query: string
  mode: 'lexical' | 'semantic'
  page: number
  limit: number
  transcripts?: Section<TranscriptResult>
  summaries?: Section<SummaryResult>
  episodes?: Section<EpisodeResult>
  shows?: Section<ShowResult>
}

interface ShowOption {
  key: string
  show_name: string
}

type Scope = 'all' | 'transcripts' | 'summaries' | 'episodes' | 'shows'
const SCOPE_LABELS: Record<Scope, string> = {
  all: 'All',
  transcripts: 'Transcripts',
  summaries: 'Summaries',
  episodes: 'Episodes',
  shows: 'Shows',
}

// The transcript RPC wraps matches in private-use sentinels ( / ) so the
// snippet can be HTML-escaped here and then have only the marks reintroduced —
// a transcript can never inject markup. Mirror the sentinels in migration 022.
const HL_START = ''
const HL_STOP = ''

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function renderSnippet(snippet: string): { __html: string } {
  const marked = escapeHtml(snippet)
    .split(HL_START).join('<mark class="bg-yellow-200 dark:bg-yellow-500/40 rounded px-0.5">')
    .split(HL_STOP).join('</mark>')
  return { __html: marked }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Highlight query terms in plain (non-transcript) text: escape first, then wrap
// case-insensitive token matches in <mark>. Used for summary/metadata snippets.
function highlightPlain(text: string, query: string): { __html: string } {
  const escaped = escapeHtml(text)
  const tokens = query.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2).map(escapeRegExp)
  if (tokens.length === 0) return { __html: escaped }
  const re = new RegExp(`(${tokens.join('|')})`, 'gi')
  return { __html: escaped.replace(re, '<mark class="bg-yellow-200 dark:bg-yellow-500/40 rounded px-0.5">$1</mark>') }
}

function formatSeek(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`
}

export default function SearchPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const qParam = searchParams.get('q') ?? ''
  const scopeRaw = searchParams.get('scope') ?? 'transcripts'
  const scope: Scope = (['all', 'transcripts', 'summaries', 'episodes', 'shows'] as Scope[]).includes(scopeRaw as Scope)
    ? (scopeRaw as Scope)
    : 'transcripts'
  const showKeyParam = searchParams.get('show_key') ?? ''
  // Defaults to the current quarter; the explicit `all` sentinel (distinct from
  // an absent param) means "search every quarter" and survives updateParams.
  const quarterParam = searchParams.get('quarter') ?? `${getCurrentQuarter().year}-Q${getCurrentQuarter().quarter}`
  const quarterApiValue = quarterParam === 'all' ? '' : quarterParam
  const modeParam = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const limit = 20

  // Mode (Exact/Smart) only affects transcript ranking.
  const modeApplies = scope === 'transcripts' || scope === 'all'
  // Quarter/Show only narrow episode-backed scopes, not the Shows scope.
  const filtersApply = scope !== 'shows'

  const [queryLocal, setQueryLocal] = useState(qParam)
  const [data, setData] = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [shows, setShows] = useState<ShowOption[]>([])

  useEffect(() => { setQueryLocal(qParam) }, [qParam])

  const updateParamsRef = useRef(searchParams)
  updateParamsRef.current = searchParams

  const updateParams = useCallback((updates: Record<string, string>) => {
    const params = new URLSearchParams(updateParamsRef.current.toString())
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [router, pathname])

  // Debounce the query input to the URL (350ms — same as the episodes page).
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  function setQuery(v: string) {
    setQueryLocal(v)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => updateParams({ q: v, page: '' }), 350)
  }

  // Load shows for the Show filter dropdown.
  useEffect(() => {
    async function fetchShows() {
      try {
        const res = await authedFetch('/api/shows')
        if (res.ok) {
          const json = await res.json()
          if (Array.isArray(json.shows)) {
            setShows(
              json.shows
                .map((s: { key: string; show_name: string }) => ({ key: s.key, show_name: s.show_name }))
                .sort((a: ShowOption, b: ShowOption) => a.show_name.localeCompare(b.show_name))
            )
          }
        }
      } catch {
        // dropdown just stays empty
      }
    }
    fetchShows()
  }, [])

  const runSearch = useCallback(async () => {
    if (qParam.trim().length < 2) {
      setData(null)
      setSearched(false)
      return
    }
    setLoading(true)
    const params = new URLSearchParams({ q: qParam, scope, page: String(page), limit: String(limit) })
    if (showKeyParam) params.set('show_key', showKeyParam)
    if (quarterApiValue) params.set('quarter', quarterApiValue)
    if (modeParam === 'semantic') params.set('mode', 'semantic')
    const res = await authedFetch(`/api/search?${params}`)
    if (res.ok) {
      setData(await res.json())
    } else {
      setData(null)
    }
    setSearched(true)
    setLoading(false)
  }, [qParam, scope, showKeyParam, quarterApiValue, modeParam, page])

  useEffect(() => { runSearch() }, [runSearch])

  function setPage(p: number) { updateParams({ page: p <= 1 ? '' : String(p) }) }

  // Quarter options (current quarter back two years, never future), matching
  // the episodes page.
  const quarterOptions = getQuarterOptions().map((o) => ({
    label: o.label,
    value: `${o.year}-Q${o.quarter}`,
  }))

  const degraded = Boolean(data?.transcripts?.degraded)

  // Single-scope total drives the pagination footer; "all" is preview-only.
  const sectionTotal =
    scope === 'transcripts' ? data?.transcripts?.total ?? 0
    : scope === 'summaries' ? data?.summaries?.total ?? 0
    : scope === 'episodes' ? data?.episodes?.total ?? 0
    : scope === 'shows' ? data?.shows?.total ?? 0
    : 0
  const totalPages = scope === 'all' ? 1 : Math.ceil(sectionTotal / limit)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Search</h2>
        <p className="text-sm text-gray-500 dark:text-warm-400">
          {scope === 'shows'
            ? 'Find a show by name or key.'
            : scope === 'summaries'
            ? 'Find episodes by what their AI summary says.'
            : scope === 'episodes'
            ? 'Find episodes by show, headline, host, guest, or category.'
            : modeParam === 'semantic'
            ? 'Smart search finds passages by meaning — even when the exact words weren’t said — and still deep-links to the audio.'
            : 'Find where a word or phrase was said across every show’s transcript.'}
        </p>
      </div>

      {/* Search bar + filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          autoFocus
          placeholder="Search…"
          value={queryLocal}
          onChange={(e) => setQuery(e.target.value)}
          className="border rounded px-3 py-2 text-sm w-80 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
        />
        <select
          value={scope}
          onChange={(e) => updateParams({ scope: e.target.value === 'transcripts' ? '' : e.target.value, page: '' })}
          className="border rounded px-2 py-2 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
          title="What to search"
        >
          {(['all', 'transcripts', 'summaries', 'episodes', 'shows'] as Scope[]).map((s) => (
            <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
          ))}
        </select>
        {filtersApply && (
          <>
            <select
              value={showKeyParam}
              onChange={(e) => updateParams({ show_key: e.target.value, page: '' })}
              className="border rounded px-2 py-2 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="">All Shows</option>
              {shows.map((s) => (
                <option key={s.key} value={s.key}>{s.show_name}</option>
              ))}
            </select>
            <select
              value={quarterParam}
              onChange={(e) => updateParams({ quarter: e.target.value, page: '' })}
              className="border rounded px-2 py-2 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="all">All Quarters</option>
              {quarterOptions.map((q) => (
                <option key={q.value} value={q.value}>{q.label}</option>
              ))}
            </select>
          </>
        )}

        {/* Exact (lexical, free) vs Smart (hybrid FTS + vector). Only affects
            transcript results, so hidden for non-transcript scopes. */}
        {modeApplies && (
          <div className="inline-flex rounded border overflow-hidden text-sm dark:border-warm-600" title="Affects transcript results">
            {(['lexical', 'semantic'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => updateParams({ mode: m === 'semantic' ? 'semantic' : '', page: '' })}
                className={
                  (modeParam === m
                    ? 'bg-blue-600 text-white dark:bg-blue-700'
                    : 'bg-white text-gray-700 dark:bg-warm-800 dark:text-warm-300') +
                  ' px-3 py-2'
                }
              >
                {m === 'lexical' ? 'Exact' : 'Smart'}
              </button>
            ))}
          </div>
        )}
      </div>

      {degraded && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Smart search is temporarily unavailable — showing exact matches instead.
        </p>
      )}

      {/* Result count (single scopes only) */}
      {searched && !loading && scope !== 'all' && (
        <p className="text-sm text-gray-500 dark:text-warm-400">
          {sectionTotal === 0 ? 'No matches.' : `${sectionTotal} match${sectionTotal === 1 ? '' : 'es'}.`}
        </p>
      )}

      {/* Results */}
      {loading ? (
        <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
          <table className="w-full"><tbody className="divide-y dark:divide-warm-700"><SkeletonTableRows rows={6} /></tbody></table>
        </div>
      ) : !searched ? (
        <p className="px-4 py-10 text-center text-gray-400 dark:text-warm-500 text-sm">
          Enter at least 2 characters to search.
        </p>
      ) : scope === 'all' ? (
        <AllResults data={data} query={qParam} onScope={(s) => updateParams({ scope: s, page: '' })} />
      ) : scope === 'transcripts' ? (
        <TranscriptList results={data?.transcripts?.results ?? []} />
      ) : scope === 'summaries' ? (
        <SummaryList results={data?.summaries?.results ?? []} query={qParam} />
      ) : scope === 'episodes' ? (
        <EpisodeList results={data?.episodes?.results ?? []} query={qParam} />
      ) : (
        <ShowList results={data?.shows?.results ?? []} query={qParam} />
      )}

      {/* Pagination (single scopes only) */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500 dark:text-warm-400">{sectionTotal} total</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page === 1}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50 dark:border-warm-600 dark:text-warm-300"
            >
              Previous
            </button>
            <span className="px-3 py-1.5 text-sm">Page {page} of {totalPages}</span>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page === totalPages}
              className="px-3 py-1.5 text-sm border rounded disabled:opacity-50 dark:border-warm-600 dark:text-warm-300"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Per-scope result renderers ─── */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
      {children}
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p className="px-4 py-10 text-center text-gray-500 dark:text-warm-400 text-sm">{label}</p>
}

function TranscriptList({ results }: { results: TranscriptResult[] }) {
  if (results.length === 0) return <Card><Empty label="No transcripts matched your search." /></Card>
  return (
    <Card>
      <ul className="divide-y dark:divide-warm-700">
        {results.map((r) => {
          const seek = r.startMs != null ? `?seek=${(r.startMs / 1000).toFixed(1)}` : ''
          return (
            <li key={`${r.episodeId}-${r.startMs ?? 0}`} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-warm-700/50">
              <a href={`/dashboard/episodes/${r.episodeId}${seek}`} className="block">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-blue-700 dark:text-blue-400">{r.showName ?? `Episode ${r.episodeId}`}</span>
                  <span className="text-gray-400 dark:text-warm-500">·</span>
                  <span className="text-gray-500 dark:text-warm-400">{r.airDate ?? '—'}</span>
                  {r.matchType === 'semantic' && (
                    <span className="inline-flex items-center text-[10px] font-medium uppercase tracking-wide text-purple-700 bg-purple-100 dark:text-purple-300 dark:bg-purple-500/20 rounded px-1.5 py-0.5" title="Matched by meaning, not exact words">
                      &asymp; match
                    </span>
                  )}
                  {r.startMs != null && (
                    <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-white bg-blue-600 dark:bg-blue-700 rounded px-2 py-0.5">
                      <span>&#9654;</span> {formatSeek(r.startMs)}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-700 dark:text-warm-300 mt-1" dangerouslySetInnerHTML={renderSnippet(r.snippet)} />
              </a>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function SummaryList({ results, query }: { results: SummaryResult[]; query: string }) {
  if (results.length === 0) return <Card><Empty label="No summaries matched your search." /></Card>
  return (
    <Card>
      <ul className="divide-y dark:divide-warm-700">
        {results.map((r) => (
          <li key={r.episodeId} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-warm-700/50">
            <a href={`/dashboard/episodes/${r.episodeId}`} className="block">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-blue-700 dark:text-blue-400">{r.showName ?? `Episode ${r.episodeId}`}</span>
                <span className="text-gray-400 dark:text-warm-500">·</span>
                <span className="text-gray-500 dark:text-warm-400">{r.airDate ?? '—'}</span>
              </div>
              <p className="text-sm text-gray-700 dark:text-warm-300 mt-1" dangerouslySetInnerHTML={highlightPlain(r.snippet, query)} />
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function EpisodeList({ results, query }: { results: EpisodeResult[]; query: string }) {
  if (results.length === 0) return <Card><Empty label="No episodes matched your search." /></Card>
  return (
    <Card>
      <ul className="divide-y dark:divide-warm-700">
        {results.map((r) => (
          <li key={r.episodeId} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-warm-700/50">
            <a href={`/dashboard/episodes/${r.episodeId}`} className="block">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-blue-700 dark:text-blue-400">{r.showName ?? `Episode ${r.episodeId}`}</span>
                <span className="text-gray-400 dark:text-warm-500">·</span>
                <span className="text-gray-500 dark:text-warm-400">{r.airDate ?? '—'}</span>
                {r.category && (
                  <span className="ml-auto text-[10px] font-medium text-gray-600 bg-gray-100 dark:text-warm-300 dark:bg-warm-700 rounded px-1.5 py-0.5">{r.category}</span>
                )}
              </div>
              {r.headline && (
                <p className="text-sm text-gray-800 dark:text-warm-200 mt-1" dangerouslySetInnerHTML={highlightPlain(r.headline, query)} />
              )}
              {(r.host || r.guest) && (
                <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5" dangerouslySetInnerHTML={highlightPlain([r.host && `Host: ${r.host}`, r.guest && `Guest: ${r.guest}`].filter(Boolean).join(' · '), query)} />
              )}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

function ShowList({ results, query }: { results: ShowResult[]; query: string }) {
  if (results.length === 0) return <Card><Empty label="No shows matched your search." /></Card>
  return (
    <Card>
      <ul className="divide-y dark:divide-warm-700">
        {results.map((r) => (
          <li key={r.key} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-warm-700/50">
            <a href={`/dashboard/shows/${encodeURIComponent(r.key)}`} className="block">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium text-blue-700 dark:text-blue-400" dangerouslySetInnerHTML={highlightPlain(r.display, query)} />
                <span className="text-gray-400 dark:text-warm-500">·</span>
                <span className="text-gray-500 dark:text-warm-400 font-mono text-xs" dangerouslySetInnerHTML={highlightPlain(r.key, query)} />
                {!r.active && (
                  <span className="text-[10px] font-medium text-gray-500 bg-gray-100 dark:text-warm-400 dark:bg-warm-700 rounded px-1.5 py-0.5">inactive</span>
                )}
                {r.category && (
                  <span className="ml-auto text-[10px] font-medium text-gray-600 bg-gray-100 dark:text-warm-300 dark:bg-warm-700 rounded px-1.5 py-0.5">{r.category}</span>
                )}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// Combined "All" view: a labeled section per scope with a "View all" jump.
function AllResults({ data, query, onScope }: { data: SearchResponse | null; query: string; onScope: (s: Scope) => void }) {
  if (!data) return <Card><Empty label="No matches." /></Card>
  const sections = [
    { scope: 'transcripts' as Scope, total: data.transcripts?.total ?? 0, node: <TranscriptList results={data.transcripts?.results ?? []} /> },
    { scope: 'summaries' as Scope, total: data.summaries?.total ?? 0, node: <SummaryList results={data.summaries?.results ?? []} query={query} /> },
    { scope: 'episodes' as Scope, total: data.episodes?.total ?? 0, node: <EpisodeList results={data.episodes?.results ?? []} query={query} /> },
    { scope: 'shows' as Scope, total: data.shows?.total ?? 0, node: <ShowList results={data.shows?.results ?? []} query={query} /> },
  ].filter((s) => s.total > 0)

  if (sections.length === 0) return <Card><Empty label="No matches in any scope." /></Card>

  return (
    <div className="space-y-5">
      {sections.map((s) => (
        <div key={s.scope} className="space-y-2">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-warm-400">
              {SCOPE_LABELS[s.scope]} <span className="text-gray-400 dark:text-warm-500 font-normal normal-case">({s.total})</span>
            </h3>
            <button onClick={() => onScope(s.scope)} className="text-xs text-blue-600 hover:underline dark:text-blue-400">
              View all {s.total} &rarr;
            </button>
          </div>
          {s.node}
        </div>
      ))}
    </div>
  )
}
