import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { getQuarterDateRange } from '@/lib/qir-format'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const { searchParams } = new URL(request.url)
    const year = parseInt(searchParams.get('year') ?? '0')
    const quarter = parseInt(searchParams.get('quarter') ?? '0')
    const type = searchParams.get('type') // transcripts | vtts | episodes

    if (!year || !quarter || !type) {
      return NextResponse.json(
        { error: 'year, quarter, and type required' },
        { status: 400 }
      )
    }

    const { start, end } = getQuarterDateRange(year, quarter)

    if (type === 'episodes') {
      const { data: episodes, error } = await supabase
        .from('episode_log')
        .select('*')
        .eq('station_id', stationId)
        .gte('air_date', start)
        .lte('air_date', end)
        .order('air_date', { ascending: true })

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      const rows = episodes ?? []
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.DOWNLOADS_EXPORT,
        operation: 'export',
        actorId: ctx.userId,
        stationId,
        resourceType: 'episode',
        metadata: { type, format: 'csv', year, quarter, count: rows.length },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      const headers = [
        'id', 'show_name', 'category', 'status', 'air_date', 'start_time',
        'end_time', 'duration', 'headline', 'host', 'guest',
        'issue_category', 'summary', 'mp3_url',
      ]
      const csvLines = [
        headers.join(','),
        ...rows.map((r: Record<string, unknown>) =>
          headers
            .map((h) => {
              const val = String(r[h] ?? '')
              return val.includes(',') || val.includes('"') || val.includes('\n')
                ? `"${val.replace(/"/g, '""')}"`
                : val
            })
            .join(',')
        ),
      ]

      return new NextResponse(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="episodes_Q${quarter}_${year}.csv"`,
        },
      })
    }

    if (type === 'transcripts' || type === 'vtts') {
      // Get episodes with transcripts for this quarter
      const { data: episodes, error } = await supabase
        .from('episode_log')
        .select('id, show_name, air_date, show_key')
        .eq('station_id', stationId)
        .gte('air_date', start)
        .lte('air_date', end)
        .in('status', ['transcribed', 'summarized'])
        .order('air_date', { ascending: true })

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }

      if (!episodes?.length) {
        return NextResponse.json(
          { error: 'No transcripts found for this quarter' },
          { status: 404 }
        )
      }

      const epIds = episodes.map((e) => e.id)
      // transcripts has no station_id; scope via the episode_log join.
      const { data: transcripts } = await supabase
        .from('transcripts')
        .select('episode_id, transcript, vtt, episode_log!inner(station_id)')
        .in('episode_id', epIds)
        .eq('episode_log.station_id', stationId)

      if (!transcripts?.length) {
        return NextResponse.json(
          { error: 'No transcript data found' },
          { status: 404 }
        )
      }

      const transcriptMap = new Map(transcripts.map((t) => [t.episode_id, t]))

      // Build a simple concatenated text file (zip would require a library)
      const field = type === 'transcripts' ? 'transcript' : 'vtt'
      const ext = type === 'transcripts' ? 'txt' : 'vtt'
      const parts: string[] = []

      for (const ep of episodes) {
        const t = transcriptMap.get(ep.id)
        const content = t?.[field]
        if (content) {
          const safeName = (ep.show_name ?? ep.show_key ?? `ep${ep.id}`)
            .replace(/[^a-zA-Z0-9_-]/g, '_')
          parts.push(
            `${'='.repeat(60)}\n` +
            `FILE: ${safeName}_${ep.air_date}_${ep.id}.${ext}\n` +
            `${'='.repeat(60)}\n\n` +
            content + '\n\n'
          )
        }
      }

      const combined = parts.join('')
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.DOWNLOADS_EXPORT,
        operation: 'export',
        actorId: ctx.userId,
        stationId,
        resourceType: 'transcript',
        metadata: { type, year, quarter, episodeCount: episodes.length },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
      return new NextResponse(combined, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Disposition': `attachment; filename="${type}_Q${quarter}_${year}.txt"`,
        },
      })
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err) {
    console.error('GET /api/downloads failed:', err)
    return NextResponse.json({ error: 'Failed to generate download' }, { status: 500 })
  }
})
