import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/compliance — list flags with pagination and filters, or stats summary
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)

    // GET /api/compliance?stats=true — return unresolved counts by type and severity
    if (searchParams.get('stats') === 'true') {
      const { data, error } = await supabaseAdmin
        .from('compliance_flags')
        .select('flag_type, severity')
        .eq('resolved', false)

      if (error) throw error

      const byType: Record<string, number> = {}
      const bySeverity: Record<string, number> = {}
      for (const flag of data ?? []) {
        byType[flag.flag_type] = (byType[flag.flag_type] ?? 0) + 1
        bySeverity[flag.severity] = (bySeverity[flag.severity] ?? 0) + 1
      }

      return NextResponse.json({ stats: { byType, bySeverity, total: (data ?? []).length } })
    }

    const episodeId = searchParams.get('episode_id')
    const flagType = searchParams.get('flag_type')
    const severity = searchParams.get('severity')
    const unresolvedOnly = searchParams.get('unresolved') === 'true'
    const resolvedOnly = searchParams.get('resolved') === 'true'
    const quarter = searchParams.get('quarter')
    const year = searchParams.get('year')
    const show = searchParams.get('show')
    const page = parseInt(searchParams.get('page') ?? '1')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)
    const offset = (page - 1) * limit
    const allowedSortColumns = ['created_at', 'flag_type', 'severity', 'resolved']
    const sortByRaw = searchParams.get('sort') ?? 'created_at'
    const sortBy = allowedSortColumns.includes(sortByRaw) ? sortByRaw : 'created_at'
    const sortDir = searchParams.get('dir') === 'asc'

    // Build query with count for pagination
    let query = supabaseAdmin
      .from('compliance_flags')
      .select('*, episode_log!inner(show_name, show_key, air_date, headline)', { count: 'exact' })
      .order(sortBy, { ascending: sortDir })
      .range(offset, offset + limit - 1)

    if (episodeId) query = query.eq('episode_id', parseInt(episodeId))
    if (flagType) query = query.eq('flag_type', flagType)
    if (severity) query = query.eq('severity', severity)
    if (unresolvedOnly) query = query.eq('resolved', false)
    if (resolvedOnly) query = query.eq('resolved', true)

    // Filter by quarter/year via the joined episode_log
    if (quarter && year) {
      const q = parseInt(quarter)
      const y = parseInt(year)
      const start = new Date(y, (q - 1) * 3, 1).toISOString().slice(0, 10)
      const end = new Date(y, q * 3, 0).toISOString().slice(0, 10)
      query = query.gte('episode_log.air_date', start).lte('episode_log.air_date', end)
    }

    if (show) {
      query = query.ilike('episode_log.show_name', `%${show}%`)
    }

    const { data, error, count } = await query
    if (error) throw error

    return NextResponse.json({
      flags: data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    })
  } catch (err) {
    console.error('GET /api/compliance failed:', err)
    return NextResponse.json({ error: 'Failed to fetch compliance flags' }, { status: 500 })
  }
}

// PATCH /api/compliance — resolve/unresolve flags (single or bulk)
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()

    // Bulk resolve: { ids: number[], resolved_by, resolved_notes }
    if (Array.isArray(body.ids)) {
      const { ids, resolved, resolved_by, resolved_notes } = body
      if (!ids.length) return NextResponse.json({ error: 'ids array required' }, { status: 400 })

      const update: Record<string, unknown> = { resolved: resolved ?? true }
      if (resolved_by) update.resolved_by = resolved_by
      if (resolved_notes !== undefined) update.resolved_notes = resolved_notes

      const { error } = await supabaseAdmin
        .from('compliance_flags')
        .update(update)
        .in('id', ids)

      if (error) throw error
      return NextResponse.json({ ok: true, count: ids.length })
    }

    // Single resolve: { id, resolved, resolved_by, resolved_notes }
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
