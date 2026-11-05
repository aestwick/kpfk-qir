import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { isComplianceBlocking } from '@/lib/settings'
import { getQuarterDateRange, QIR_CANDIDATE_STATUSES, quarterEpisodeOrFilter } from '@/lib/qir-format'
import { fetchBlockingFlags, summarizeBlockedEpisodes } from '@/lib/compliance-blocking'

export const dynamic = 'force-dynamic'

/**
 * GET /api/qir/blocking?year=YYYY&quarter=N
 *
 * Which of this quarter's report candidates compliance blocking holds out of
 * the QIR draft RIGHT NOW — the exact set workers/generate-qir.ts would skip
 * (same candidate query, same flag rule via lib/compliance-blocking.ts).
 * Computed live rather than read from the draft, so reviewing a flag on the
 * Review-flags page shows up here on the next load.
 *
 * Episodes are listed (and their flags counted) even when blocking is OFF, so
 * the page can say "N episodes WOULD be held out if blocking were on".
 */
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const year = parseInt(searchParams.get('year') ?? '')
    const quarter = parseInt(searchParams.get('quarter') ?? '')
    if (!Number.isInteger(year) || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      return NextResponse.json({ error: 'year and quarter (1-4) required' }, { status: 400 })
    }

    const { start, end } = getQuarterDateRange(year, quarter)
    const PAGE = 1000
    const episodes: { id: number; show_name: string | null; air_date: string | null }[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('episode_log')
        .select('id, show_name, air_date')
        .eq('station_id', stationId)
        .in('status', [...QIR_CANDIDATE_STATUSES])
        .or(quarterEpisodeOrFilter(start, end))
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw error
      episodes.push(...(data ?? []))
      if (!data || data.length < PAGE) break
    }

    const [enabled, flags] = await Promise.all([
      isComplianceBlocking(),
      fetchBlockingFlags(supabase, episodes.map((e) => e.id)),
    ])
    const byId = new Map(episodes.map((e) => [e.id, e]))
    const blocked = summarizeBlockedEpisodes(flags).map((b) => ({
      ...b,
      show_name: byId.get(b.episode_id)?.show_name ?? null,
      air_date: byId.get(b.episode_id)?.air_date ?? null,
    }))
    blocked.sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? '') || a.episode_id - b.episode_id)

    return NextResponse.json({
      year,
      quarter,
      blocking_enabled: enabled,
      candidates: episodes.length,
      blocking_flags: blocked.reduce((n, b) => n + b.blocking_flags, 0),
      unreviewed_flags: blocked.reduce((n, b) => n + b.unreviewed, 0),
      blocked,
    })
  } catch (err) {
    console.error('GET /api/qir/blocking failed:', err)
    return NextResponse.json({ error: 'Failed to check compliance blocking' }, { status: 500 })
  }
}
