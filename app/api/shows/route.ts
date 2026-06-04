import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { resolveShowDisplayName, resolveShowGroup } from '@/lib/shows'

export const dynamic = 'force-dynamic'

// List the active station's shows (key + name), for populating filter dropdowns
// like the one on the transcript search page. Scoped to the active station via
// the request-scoped RLS client plus an explicit station_id filter.
export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get('active') === 'true'

    let query = supabase
      .from('show_keys')
      .select('key, show_name, feed_name, display_name, show_group, category, active')
      .eq('station_id', stationId)
      .order('show_name')

    if (activeOnly) query = query.eq('active', true)

    const [{ data, error }, { data: station }] = await Promise.all([
      query,
      supabase
        .from('stations')
        .select('show_name_strip_prefixes')
        .eq('id', stationId)
        .maybeSingle(),
    ])
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const stripPrefixes = station?.show_name_strip_prefixes ?? null

    // Additively expose the resolved display name + grouping identity alongside
    // the raw row, so listings can show a clean name without breaking existing
    // consumers that still read show_name.
    const shows = (data ?? []).map((row) => ({
      ...row,
      display: resolveShowDisplayName(row, stripPrefixes),
      group: resolveShowGroup(row),
    }))

    return NextResponse.json({ shows })
  } catch (err) {
    console.error('GET /api/shows failed:', err)
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 })
  }
})
