import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/compliance — list flags, optionally filtered by episode_id or flag_type
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const episodeId = searchParams.get('episode_id')
    const flagType = searchParams.get('flag_type')
    const unresolvedOnly = searchParams.get('unresolved') === 'true'

    let query = supabaseAdmin
      .from('compliance_flags')
      .select('*')
      .order('created_at', { ascending: false })

    if (episodeId) query = query.eq('episode_id', parseInt(episodeId))
    if (flagType) query = query.eq('flag_type', flagType)
    if (unresolvedOnly) query = query.eq('resolved', false)

    const { data, error } = await query.limit(200)
    if (error) throw error

    return NextResponse.json({ flags: data })
  } catch (err) {
    console.error('GET /api/compliance failed:', err)
    return NextResponse.json({ error: 'Failed to fetch compliance flags' }, { status: 500 })
  }
}

// PATCH /api/compliance — resolve/unresolve a flag
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { id, resolved, resolved_by, resolved_notes } = body

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    const update: Record<string, unknown> = { resolved: resolved ?? true }
    if (resolved_by) update.resolved_by = resolved_by
    if (resolved_notes !== undefined) update.resolved_notes = resolved_notes

    const { error } = await supabaseAdmin
      .from('compliance_flags')
      .update(update)
      .eq('id', id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/compliance failed:', err)
    return NextResponse.json({ error: 'Failed to update compliance flag' }, { status: 500 })
  }
}
