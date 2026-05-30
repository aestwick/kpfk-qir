import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
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

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

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

// POST /api/settings — bulk-create show_keys for the active station.
// Body: { resource: 'shows', shows: [{ key, show_name, default_category?, primary_language? }] }
// Upserts on (station_id, key): existing keys are updated, new keys inserted.
export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    if (body.resource !== 'shows') {
      return NextResponse.json({ error: 'Unknown resource' }, { status: 400 })
    }

    const input = Array.isArray(body.shows) ? body.shows : []
    if (input.length === 0) {
      return NextResponse.json({ error: 'No shows provided' }, { status: 400 })
    }

    // Normalize + validate. A row needs a key and a name; everything else is optional.
    // De-dupe by key within the payload (last write wins) so a doubled paste row
    // doesn't trip the upsert's "cannot affect row a second time" error.
    const byKey = new Map<string, { station_id: string; key: string; show_name: string; default_category: string | null; primary_language: string | null; active: boolean }>()
    const skipped: { row: number; reason: string }[] = []

    input.forEach((raw: Record<string, unknown>, i: number) => {
      const key = String(raw.key ?? '').trim()
      const show_name = String(raw.show_name ?? '').trim()
      if (!key || !show_name) {
        skipped.push({ row: i, reason: 'missing key or name' })
        return
      }
      const default_category = raw.default_category != null && String(raw.default_category).trim() !== ''
        ? String(raw.default_category).trim() : null
      const primary_language = raw.primary_language != null && String(raw.primary_language).trim() !== ''
        ? String(raw.primary_language).trim().toLowerCase() : null
      byKey.set(key, { station_id: stationId, key, show_name, default_category, primary_language, active: true })
    })

    const rows = Array.from(byKey.values())
    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid rows', skipped }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('show_keys')
      .upsert(rows, { onConflict: 'station_id,key' })
      .select('*')

    if (error) throw error

    return NextResponse.json({ ok: true, count: data?.length ?? rows.length, shows: data ?? [], skipped })
  } catch (err) {
    console.error('POST /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to create shows' }, { status: 500 })
  }
}

// PATCH /api/settings — update show_keys
export async function PATCH(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { resource, id, ...updates } = body

    if (resource === 'show') {
      if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

      const allowedFields = ['show_name', 'category', 'default_category', 'primary_language', 'active', 'email']
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
