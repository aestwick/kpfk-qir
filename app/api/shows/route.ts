import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// List the active station's shows (key + name), for populating filter dropdowns
// like the one on the transcript search page. Scoped to the active station via
// the request-scoped RLS client plus an explicit station_id filter.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const activeOnly = searchParams.get('active') === 'true'

    let query = supabase
      .from('show_keys')
      .select('key, show_name, category, active')
      .eq('station_id', stationId)
      .order('show_name')

    if (activeOnly) query = query.eq('active', true)

    const { data, error } = await query
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ shows: data ?? [] })
  } catch (err) {
    console.error('GET /api/shows failed:', err)
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 })
  }
}
