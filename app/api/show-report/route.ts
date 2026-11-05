import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { loadShowCatalog, groupKeysFor } from '@/lib/show-catalog'
import { buildShowReport, dedupeAirings, type ReportEpisodeRow } from '@/lib/show-report'
import { isIsoDate, monthRange, stationToday } from '@/lib/broadcast-format'

export const dynamic = 'force-dynamic'

const MAX_DAYS = 400
const PAGE = 1000
const MAX_ROWS = 6000

// GET /api/show-report?show=<feed key or group>&from=YYYY-MM-DD&to=YYYY-MM-DD
// What one logical show (all its feeds — show_group) covered over a period:
// the episode list plus issue / guest / host tallies. Defaults to this month.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const sp = new URL(request.url).searchParams
    const show = (sp.get('show') ?? '').trim()
    if (!show) return NextResponse.json({ error: 'show is required' }, { status: 400 })

    const { data: station } = await supabase.from('stations').select('timezone').eq('id', stationId).maybeSingle()
    const month = monthRange(stationToday(station?.timezone || 'America/Los_Angeles'))
    const from = sp.get('from') || month.from
    const to = sp.get('to') || month.to
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      return NextResponse.json({ error: 'from/to must be YYYY-MM-DD with from ≤ to' }, { status: 400 })
    }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_DAYS) {
      return NextResponse.json({ error: `Pick a range of ${MAX_DAYS} days or less` }, { status: 400 })
    }

    const catalog = await loadShowCatalog(supabase, stationId)
    const keys = groupKeysFor(catalog, show)
    const showInfo = catalog.byKey.get(keys[0])

    // Page through (PostgREST caps a response at 1,000 rows): a multi-feed show
    // over a long range can exceed it. MAX_ROWS keeps a runaway range bounded,
    // and `truncated` says so instead of silently under-counting.
    const all: ReportEpisodeRow[] = []
    let truncated = false
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .from('episode_log')
        .select('id, show_key, air_date, air_start, duration, headline, title, summary, host, guest, issue_category, status')
        .eq('station_id', stationId)
        .in('show_key', keys)
        .gte('air_date', from)
        .lte('air_date', to)
        .neq('status', 'archived')
        .order('air_date', { ascending: true })
        .order('air_start', { ascending: true })
        .order('id', { ascending: true })
        .range(offset, offset + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      all.push(...((data ?? []) as ReportEpisodeRow[]))
      if (!data || data.length < PAGE) break
      if (all.length >= MAX_ROWS) {
        truncated = true
        break
      }
    }

    const rows = dedupeAirings(all)
    return NextResponse.json({
      truncated,
      show: { key: keys[0], name: showInfo?.name ?? show, keys, category: showInfo?.category ?? null },
      from,
      to,
      ...buildShowReport(rows),
      episodes: rows.map((r) => ({
        id: r.id,
        showKey: r.show_key,
        airDate: r.air_date,
        airStart: r.air_start,
        duration: r.duration,
        headline: r.headline || r.title,
        host: r.host,
        guest: r.guest,
        issueCategory: r.issue_category,
        status: r.status,
      })),
    })
  } catch (err) {
    console.error('GET /api/show-report failed:', err)
    return NextResponse.json({ error: 'Failed to build the show report' }, { status: 500 })
  }
}
