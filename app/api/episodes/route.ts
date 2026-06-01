import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { parseMp3Url, dateFieldsFromUrl } from '@/lib/parse-mp3-url'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const show = searchParams.get('show')
    const category = searchParams.get('category')
    const quarter = searchParams.get('quarter') // e.g. "2025-Q1"
    const sort = searchParams.get('sort') ?? 'created_at'
    const order = searchParams.get('order') ?? 'desc'
    const page = parseInt(searchParams.get('page') ?? '1')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50') || 50, 500)
    const offset = (page - 1) * limit
    const format = searchParams.get('format')

    let query = supabase
      .from('episode_log')
      .select('*', { count: 'exact' })
      .eq('station_id', stationId)
      .order(sort, { ascending: order === 'asc' })
      .range(offset, offset + limit - 1)

    if (status) query = query.eq('status', status)
    const showKey = searchParams.get('show_key')
    if (showKey) query = query.eq('show_key', showKey)
    else if (show) query = query.ilike('show_name', `%${show}%`)
    if (category) query = query.eq('issue_category', category)

    if (quarter) {
      const [year, q] = quarter.split('-Q')
      const qNum = parseInt(q)
      const startMonth = (qNum - 1) * 3
      const start = new Date(parseInt(year), startMonth, 1).toISOString().slice(0, 10)
      const end = new Date(parseInt(year), startMonth + 3, 0).toISOString().slice(0, 10)
      // Match episodes by air_date, or by created_at for episodes with null air_date
      query = query.or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    }

    const since = searchParams.get('since')
    if (since) query = query.gte('updated_at', since)

    const { data, error, count } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (format === 'csv') {
      const rows = data ?? []
      const headers = ['id', 'show_name', 'category', 'status', 'air_date', 'start_time', 'duration', 'headline', 'host', 'guest', 'issue_category', 'summary']
      const csvLines = [
        headers.join(','),
        ...rows.map((r: Record<string, unknown>) =>
          headers.map((h) => {
            const val = String(r[h] ?? '')
            return val.includes(',') || val.includes('"') || val.includes('\n')
              ? `"${val.replace(/"/g, '""')}"`
              : val
          }).join(',')
        ),
      ]
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.EPISODES_EXPORT,
        operation: 'export',
        actorId: result.context.userId,
        stationId,
        resourceType: 'episode',
        metadata: { format: 'csv', count: rows.length, filters: { status, show, category, quarter } },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="episodes.csv"',
        },
      })
    }

    return NextResponse.json({ episodes: data, total: count, page, limit })
  } catch (err) {
    console.error('GET /api/episodes failed:', err)
    return NextResponse.json({ error: 'Failed to fetch episodes' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()

    if (body.action === 'bulk-retry') {
      const { error } = await supabase
        .from('episode_log')
        .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
        .eq('station_id', stationId)
        .eq('status', 'failed')

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      return NextResponse.json({ ok: true, message: 'All failed episodes reset to pending' })
    }

    if (body.action === 'bulk-fix-dates') {
      const { from, to } = body as { from?: string; to?: string }
      // The MP3 filename prefix is station-specific; default to 'kpfk' if unset.
      const { data: station } = await supabase
        .from('stations')
        .select('mp3_filename_prefix')
        .eq('id', stationId)
        .maybeSingle()
      const mp3Prefix = station?.mp3_filename_prefix ?? 'kpfk'
      // Fetch episodes in date range, re-derive dates from MP3 URLs
      let query = supabase
        .from('episode_log')
        .select('id, mp3_url, duration, air_date')
        .eq('station_id', stationId)
      if (from) query = query.gte('air_date', from)
      if (to) query = query.lte('air_date', to)
      const { data: episodes, error: fetchErr } = await query

      if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 })

      let fixed = 0
      for (const ep of episodes || []) {
        const parsed = parseMp3Url(ep.mp3_url, mp3Prefix)
        if (!parsed) continue
        const fields = dateFieldsFromUrl(parsed, ep.duration)
        const { error: updateErr } = await supabase
          .from('episode_log')
          .update(fields)
          .eq('id', ep.id)
          .eq('station_id', stationId)
        if (!updateErr) fixed++
      }

      return NextResponse.json({ ok: true, message: `Fixed dates for ${fixed} episodes` })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('POST /api/episodes failed:', err)
    return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
  }
}
