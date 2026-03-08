import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const resource = searchParams.get('resource')

    // GET /api/settings?resource=shows — return show_keys
    if (resource === 'shows') {
      const { data, error } = await supabaseAdmin
        .from('show_keys')
        .select('*')
        .order('show_name')

      if (error) throw error

      // Get episode counts per show using RPC or grouped query
      const { data: counts } = await supabaseAdmin
        .rpc('get_episode_counts_by_show')
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

    // Default: return qir_settings
    const { data, error } = await supabaseAdmin
      .from('qir_settings')
      .select('*')
      .order('key')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const settings: Record<string, unknown> = {}
    for (const row of data ?? []) {
      settings[row.key] = row.value
    }

    return NextResponse.json({ settings, rows: data })
  } catch (err) {
    console.error('GET /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 })
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json()
    const { key, value } = body

    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('qir_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PUT /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to save setting' }, { status: 500 })
  }
}

// PATCH /api/settings — update show_keys
export async function PATCH(request: NextRequest) {
  try {
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

      const { error } = await supabaseAdmin
        .from('show_keys')
        .update(safeUpdates)
        .eq('id', id)

      if (error) throw error
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'Unknown resource' }, { status: 400 })
  } catch (err) {
    console.error('PATCH /api/settings failed:', err)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }
}
