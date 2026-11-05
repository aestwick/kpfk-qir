import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import {
  searchTranscripts,
  searchTranscriptsSemantic,
  SearchError,
  MIN_QUERY_LENGTH,
  DEFAULT_LIMIT,
  MAX_LIMIT,
} from '@/lib/transcript-search'
import { loadShowCatalog, groupKeysFor } from '@/lib/show-catalog'
import { isIsoDate } from '@/lib/broadcast-format'

export const dynamic = 'force-dynamic'

// Transcript search. Thin: auth, param validation, response shaping — query
// building lives in lib/search-query.ts and SQL in the 046+ search RPCs.
//
// mode=lexical (default) -> exact words, forgiving of accents/plurals/typos.
// mode=semantic          -> exact words fused with episodes matched by meaning.
// show_key               -> expanded to every feed of that logical show.
// Errors come back as JSON with `reason` so the page can say "too broad"
// instead of pretending there were no matches.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
    const limit = Math.min(parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT)
    const mode = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'

    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ results: [], total: 0, page: 1, limit, query: q, mode, alsoMatched: [], relaxed: false })
    }

    const startDate = searchParams.get('start_date')
    const endDate = searchParams.get('end_date')
    if ((startDate && !isIsoDate(startDate)) || (endDate && !isIsoDate(endDate))) {
      return NextResponse.json({ error: 'Dates must be YYYY-MM-DD', reason: 'bad_request' }, { status: 400 })
    }

    const showKey = searchParams.get('show_key')
    const showKeys = showKey ? groupKeysFor(await loadShowCatalog(supabase, stationId), showKey) : null

    const params = {
      stationId,
      query: q,
      showKeys,
      quarter: searchParams.get('quarter'),
      startDate,
      endDate,
      page,
      limit,
    }
    const out = mode === 'semantic' ? await searchTranscriptsSemantic(supabase, params) : await searchTranscripts(supabase, params)
    return NextResponse.json({ ...out, page, limit, query: q, mode })
  } catch (err) {
    if (err instanceof SearchError && err.timedOut) {
      return NextResponse.json(
        { error: 'That search is too broad to finish in time. Add a word, pick a show, or narrow the dates.', reason: 'timeout' },
        { status: 503 }
      )
    }
    console.error('GET /api/transcript-search failed:', err)
    return NextResponse.json({ error: 'Search failed — please try again.', reason: 'error' }, { status: 500 })
  }
}
