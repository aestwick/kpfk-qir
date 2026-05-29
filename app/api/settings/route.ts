import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { invalidateSetting } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')

    // GET /api/settings?resource=shows — return show_keys
    if (resource === 'shows') {
      const { data, error } = await supabase
        .from('show_keys')
        .select('*')
        .eq('station_id', stationId)
        .order('show_name')

      if (error) throw error

      // Station-scoped episode counts per show (migration 016 overload).
      const { data: counts } = await supabaseAdmin
        .rpc('get_episode_counts_by_show', { p_station_id: stationId })
        .select('*')

      const countMap = new Map<string, number>()
      for (const row of (counts as Array<{ show_key: string; count: number }>) ?? []) {
        countMap.set(row.show_key, row.count)
      }

      const shows = (data ?? []).map((show) => ({
        ...show,
        episode_count: countMap.get(show.key) ?? 0,
      }))

      return NextResponse.json({ shows })
    }

    // Default: return the EFFECTIVE settings for the active station — global
    // qir_settings overlaid with this station's station_settings overrides.
    const [globalRes, overrideRes] = await Promise.all([
      supabaseAdmin.from('qir_settings').select('*').order('key'),
      supabase.from('station_settings').select('key, value').eq('station_id', stationId),
    ])

    if (globalRes.error) {
      return NextResponse.json({ error: globalRes.error.message }, { status: 500 })
    }
    if (overrideRes.error) {
      return NextResponse.json({ error: overrideRes.error.message }, { status: 500 })
    }

    const settings: Record<string, unknown> = {}
    for (const row of globalRes.data ?? []) {
      settings[row.key] = row.value
    }
    // Per-station override wins.
    for (const row of overrideRes.data ?? []) {
      settings[row.key] = row.value
    }

    return NextResponse.json({ settings, rows: globalRes.data })
  } catch (err) {
    console.error('GET /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const body = await request.json()
    const { key, value } = body

    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }

    // Settings edits are saved as per-station overrides in station_settings;
    // global qir_settings remains the fallback layer (resolved in lib/settings).
    const { error } = await supabase
      .from('station_settings')
      .upsert({ station_id: stationId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'station_id,key' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    invalidateSetting(key) // reflect change immediately, don't wait for cache TTL

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PUT /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }
}

// PATCH /api/settings — update show_keys
export async function PATCH(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const body = await request.json()
    const { resource, id, ...updates } = body

    if (resource === 'show') {
      if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

      const allowedFields = ['show_name', 'category', 'default_category', 'active', 'email']
      const safeUpdates: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          safeUpdates[key] = value
        }
      }

      if (Object.keys(safeUpdates).length === 0) {
        return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
      }

      safeUpdates.updated_at = new Date().toISOString()

      const { error } = await supabase
        .from('show_keys')
        .update(safeUpdates)
        .eq('id', id)
        .eq('station_id', stationId)

      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown resource' }, { status: 400 })
  } catch (err) {
    console.error('PATCH /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}
