import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'

export const dynamic = 'force-dynamic'

// Distinct program categories (genre) for the active station, with episode
// counts — populates the genre filter on the episodes page. Backed by the
// get_episode_categories RPC (migration 039), which runs as SECURITY INVOKER so
// RLS scopes it to the caller's station. Archived (PRA) rows are excluded.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { data, error } = await supabase.rpc('get_episode_categories', { p_station_id: stationId })
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ categories: data ?? [] })
  } catch (err) {
    console.error('GET /api/episodes/categories failed:', err)
    return NextResponse.json({ error: 'Failed to fetch categories' }, { status: 500 })
  }
}
