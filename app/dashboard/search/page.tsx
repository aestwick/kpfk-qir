'use client'

// Grid-wide transcript search (Phase 1 of ideas/TRANSCRIPT_SEARCH_SPEC.md §9.2):
// "anywhere, any show, any time frame". Searches inside transcript text, ranks
// episodes, and deep-links each hit to the audio at the matched cue timestamp.
// Pre-fill ?show_key / ?quarter to land scoped to one show (the "within a show"
// entry point linked from the episodes page).

import { useEffect, useState, useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api-client'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { getQuarterOptions, getCurrentQuarter } from '@/lib/quarters'
import { withFrom, locationFrom } from '@/lib/nav'

interface SearchResult {
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

interface ShowOption {
  key: string
  show_name: string
}

// The RPC wraps matches in private-use sentinels ( / ) so the
// snippet can be HTML-escaped here and then have only the marks reintroduced —
// a transcript can never inject markup. Mirror the sentinels in migration 022.
const HL_START = ''
const HL_STOP = ''

function renderSnippet(snippet: string): { __html: string } {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  const marked = escaped
    .split(HL_START).join('<mark class="bg-yellow-200 dark:bg-yellow-500/40 rounded px-0.5">')
    .split(HL_STOP).join('</mark>')
  return { __html: marked }
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
  const showKeyParam = searchParams.get('show_key') ?? ''
  // Defaults to the current quarter; the explicit `all` sentinel (distinct from
  // an absent param) means "search every quarter" and survives updateParams.
  const quarterParam = searchParams.get('quarter') ?? `${getCurrentQuarter().year}-Q${getCurrentQuarter().quarter}`
  const quarterApiValue = quarterParam === 'all' ? '' : quarterParam
  const modeParam = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'
  const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
  const limit = 20

  const [queryLocal, setQueryLocal] = useState(qParam)
  const [results, setResults] = useState<SearchResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [degraded, setDegraded] = useState(false)
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
          const data = await res.json()
          if (Array.isArray(data.shows)) {
            setShows(
              data.shows
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
      setResults([])
      setTotal(0)
      setSearched(false)
      return
    }
    setLoading(true)
    const params = new URLSearchParams({ q: qParam, page: String(page), limit: String(limit) })
    if (showKeyParam) params.set('show_key', showKeyParam)
    if (quarterApiValue) params.set('quarter', quarterApiValue)
    if (modeParam === 'semantic') params.set('mode', 'semantic')
    const res = await authedFetch(`/api/transcript-search?${params}`)
    if (res.ok) {
      const data = await res.json()
      setResults(data.results ?? [])
      setTotal(data.total ?? 0)
      setDegraded(Boolean(data.degraded))
    } else {
      setResults([])
      setTotal(0)
      setDegraded(false)
    }
    setSearched(true)
    setLoading(false)
  }, [qParam, showKeyParam, quarterApiValue, modeParam, page])

  useEffect(() => { runSearch() }, [runSearch])

  function setPage(p: number) { updateParams({ page: p <= 1 ? '' : String(p) }) }

  const totalPages = Math.ceil(total / limit)

  // Quarter options (current quarter back two years, never future), matching
  // the episodes page.
  const quarterOptions = getQuarterOptions().map((o) => ({
    label: o.label,
    value: `${o.year}-Q${o.quarter}`,
  }))

  const episodeCount = new Set(results.map((r) => r.episodeId)).size

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-bold">Search Transcripts</h2>
        <p className="text-sm text-gray-500 dark:text-warm-400">
          {modeParam === 'semantic'
            ? 'Smart search finds passages by meaning — even when the exact words weren’t said — and still deep-links to the audio.'
            : 'Find where a word or phrase was said across every show’s transcript.'}
          {' Try '}
          <code className="mx-1 px-1 bg-gray-100 dark:bg-warm-700 rounded">&quot;measles outbreak&quot;</code>
          {' or '}
          <code className="mx-1 px-1 bg-gray-100 dark:bg-warm-700 rounded">{modeParam === 'semantic' ? 'vaccine hesitancy' : 'housing -rent'}</code>.
        </p>
      </div>

      {/* Search bar + filters */}
      <div className="flex gap-3 flex-wrap items-center">
        <input
          type="text"
          autoFocus
          placeholder="Search transcripts…"
          value={queryLocal}
          onChange={(e) => setQuery(e.target.value)}
          className="border rounded px-3 py-2 text-sm w-80 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
        />
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

        {/* Exact (lexical, free) vs Smart (hybrid FTS + vector). Exact is the
            default — deterministic and the most trustworthy for an FCC proof. */}
        <div className="inline-flex rounded border overflow-hidden text-sm dark:border-warm-600">
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
      </div>

      {degraded && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Smart search is temporarily unavailable — showing exact matches instead.
        </p>
      )}

      {/* Result count */}
      {searched && !loading && (
        <p className="text-sm text-gray-500 dark:text-warm-400">
          {total === 0
            ? 'No matches.'
            : `${total} hit${total === 1 ? '' : 's'} across ${episodeCount} episode${episodeCount === 1 ? '' : 's'} on this page.`}
        </p>
      )}

      {/* Results */}
      <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
        {loading ? (
          <table className="w-full"><tbody className="divide-y dark:divide-warm-700"><SkeletonTableRows rows={6} /></tbody></table>
        ) : !searched ? (
          <p className="px-4 py-10 text-center text-gray-400 dark:text-warm-500 text-sm">
            Enter at least 2 characters to search.
          </p>
        ) : results.length === 0 ? (
          <p className="px-4 py-10 text-center text-gray-500 dark:text-warm-400 text-sm">
            No transcripts matched your search.
          </p>
        ) : (
          <ul className="divide-y dark:divide-warm-700">
            {results.map((r) => {
              const seek = r.startMs != null ? `?seek=${(r.startMs / 1000).toFixed(1)}` : ''
              return (
                <li key={r.episodeId} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-warm-700/50">
                  <a href={withFrom(`/dashboard/episodes/${r.episodeId}${seek}`, locationFrom(pathname, searchParams.toString()))} className="block">
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
                    <p
                      className="text-sm text-gray-700 dark:text-warm-300 mt-1"
                      dangerouslySetInnerHTML={renderSnippet(r.snippet)}
                    />
                  </a>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500 dark:text-warm-400">{total} total hits</p>
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
