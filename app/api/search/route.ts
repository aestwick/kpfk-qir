import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { searchTranscripts, searchTranscriptsSemantic } from '@/lib/transcript-search'
import {
  searchSummaries,
  searchEpisodes,
  searchShows,
  MIN_QUERY_LENGTH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ALL_PREVIEW_LIMIT,
} from '@/lib/search'

export const dynamic = 'force-dynamic'

// Unified, scoped search for the Search page. Dispatches by `scope`:
//   transcripts (default) — ranked FTS/hybrid over transcript text (+ audio seek)
//   summaries             — episode summaries / headlines
//   episodes              — episode metadata (show, headline, host, guest, category)
//   shows                 — the station's shows by name/key
//   all                   — a preview of each scope at once ("search all of them")
// Transcript ranking lives in the RPCs (lib/transcript-search); the other scopes
// are ilike scans in lib/search. Everything is station-scoped (RLS client + an
// explicit station_id arg) for defense in depth.
const SCOPES = ['transcripts', 'summaries', 'episodes', 'shows', 'all'] as const
type Scope = (typeof SCOPES)[number]

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    const scopeParam = searchParams.get('scope') as Scope | null
    const scope: Scope = scopeParam && SCOPES.includes(scopeParam) ? scopeParam : 'transcripts'
    const mode = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'
    const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
    const limit = Math.min(parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT)
    const showKey = searchParams.get('show_key')
    const quarter = searchParams.get('quarter')

    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ scope, query: q, mode, page, limit })
    }

    const base = { stationId, query: q, showKey, quarter }

    // Transcript scope: keep the ranked RPC path + semantic option.
    async function runTranscripts(perPage: number, atPage: number) {
      const tp = { ...base, page: atPage, limit: perPage }
      if (mode === 'semantic') {
        const { results, total, degraded } = await searchTranscriptsSemantic(supabase, tp)
        return { results, total, degraded }
      }
      const { results, total } = await searchTranscripts(supabase, tp)
      return { results, total, degraded: false }
    }

    if (scope === 'transcripts') {
      return NextResponse.json({ scope, query: q, mode, page, limit, transcripts: await runTranscripts(limit, page) })
    }
    if (scope === 'summaries') {
      return NextResponse.json({ scope, query: q, mode, page, limit, summaries: await searchSummaries(supabase, { ...base, page, limit }) })
    }
    if (scope === 'episodes') {
      return NextResponse.json({ scope, query: q, mode, page, limit, episodes: await searchEpisodes(supabase, { ...base, page, limit }) })
    }
    if (scope === 'shows') {
      return NextResponse.json({ scope, query: q, mode, page, limit, shows: await searchShows(supabase, { ...base, page, limit }) })
    }

    // scope === 'all': a small preview of every scope at once.
    const n = ALL_PREVIEW_LIMIT
    const [transcripts, summaries, episodes, shows] = await Promise.all([
      runTranscripts(n, 1),
      searchSummaries(supabase, { ...base, page: 1, limit: n }),
      searchEpisodes(supabase, { ...base, page: 1, limit: n }),
      searchShows(supabase, { ...base, page: 1, limit: n }),
    ])
    return NextResponse.json({ scope, query: q, mode, page: 1, limit: n, transcripts, summaries, episodes, shows })
  } catch (err) {
    console.error('GET /api/search failed:', err)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
