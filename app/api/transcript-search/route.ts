import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { searchTranscripts, searchTranscriptsSemantic, MIN_QUERY_LENGTH, DEFAULT_LIMIT, MAX_LIMIT } from '@/lib/transcript-search'

export const dynamic = 'force-dynamic'

// Transcript search. Thin: auth, param validation, pagination, response shaping —
// all SQL lives in the search RPCs via lib/transcript-search.ts. Scoped to the
// active station through the request-scoped RLS client AND an explicit station_id
// arg (defense in depth).
//
// mode=lexical (default) -> Phase-1 exact FTS, free and deterministic.
// mode=semantic          -> Phase-2 hybrid (FTS + vector), one embed/query.
export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    const page = parseInt(searchParams.get('page') ?? '1', 10) || 1
    const limit = Math.min(parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, MAX_LIMIT)
    const mode = searchParams.get('mode') === 'semantic' ? 'semantic' : 'lexical'

    // Below the minimum length we never hit the DB — return an empty page so the
    // client can clear results without special-casing.
    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ results: [], total: 0, page: 1, limit, query: q, mode })
    }

    const searchParamsForLib = {
      stationId,
      query: q,
      showKey: searchParams.get('show_key'),
      quarter: searchParams.get('quarter'),
      startDate: searchParams.get('start_date'),
      endDate: searchParams.get('end_date'),
      page,
      limit,
    }

    if (mode === 'semantic') {
      const { results, total, degraded } = await searchTranscriptsSemantic(supabase, searchParamsForLib)
      return NextResponse.json({ results, total, page, limit, query: q, mode, degraded })
    }

    const { results, total } = await searchTranscripts(supabase, searchParamsForLib)
    return NextResponse.json({ results, total, page, limit, query: q, mode })
  } catch (err) {
    console.error('GET /api/transcript-search failed:', err)
    return NextResponse.json({ error: 'Transcript search failed' }, { status: 500 })
  }
})
