import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { loadShowCatalog } from '@/lib/show-catalog'
import { buildBroadcastDay, type DayEpisodeRow } from '@/lib/broadcast-day'
import { isIsoDate, shiftDate, stationToday } from '@/lib/broadcast-format'

export const dynamic = 'force-dynamic'

// GET /api/broadcast-day?date=YYYY-MM-DD — what aired on one station-local day,
// in air-time order. air_date/air_start are station-local wall time (parsed from
// the archive MP3 filename), so no timezone conversion happens here; "today"
// defaults to the station's own calendar date. Scoped by the request's RLS client
// plus an explicit station_id filter.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { data: station } = await supabase
      .from('stations')
      .select('timezone, mp3_filename_prefix')
      .eq('id', stationId)
      .maybeSingle()
    const timezone = station?.timezone || 'America/Los_Angeles'

    const param = new URL(request.url).searchParams.get('date')
    if (param && !isIsoDate(param)) {
      return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 })
    }
    const date = param || stationToday(timezone)

    const [{ data, error }, catalog] = await Promise.all([
      supabase
        .from('episode_log')
        .select('id, show_key, show_name, air_date, air_start, air_end, duration, host, guest, headline, title, issue_category, category, status, mp3_url')
        .eq('station_id', stationId)
        .eq('air_date', date)
        .neq('status', 'archived')
        .order('air_start', { ascending: true, nullsFirst: false })
        .limit(500),
      loadShowCatalog(supabase, stationId),
    ])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const blocks = buildBroadcastDay((data ?? []) as DayEpisodeRow[], catalog, station?.mp3_filename_prefix || 'kpfk')
    return NextResponse.json({
      date,
      timezone,
      today: stationToday(timezone),
      prevDate: shiftDate(date, -1),
      nextDate: shiftDate(date, 1),
      blocks,
    })
  } catch (err) {
    console.error('GET /api/broadcast-day failed:', err)
    return NextResponse.json({ error: 'Failed to load the broadcast day' }, { status: 500 })
  }
}
