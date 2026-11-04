import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { getQuarterDateRange } from '@/lib/qir-format'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'
import { toCsv } from '@/lib/csv'
import { fetchAllRows } from '@/lib/fetch-all'
import { TRANSCRIBED_STATUSES } from '@/lib/episode-feed'

// transcripts carry up to ~225KB of VTT each, so fetch them in small id batches
// (also keeps the .in() list well under URL-length limits).
const TRANSCRIPT_BATCH = 50

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

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
      // Paged: a quarter is ~2,000 episodes and PostgREST caps a response at
      // 1000, so the CSV used to stop silently around mid-August.
      let rows: Record<string, unknown>[]
      try {
        rows = await fetchAllRows('episodes', (from, to) =>
          supabase
            .from('episode_log')
            .select('*')
            .eq('station_id', stationId)
            .gte('air_date', start)
            .lte('air_date', end)
            .order('air_date', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)
        )
      } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 })
      }
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.DOWNLOADS_EXPORT,
        operation: 'export',
        actorId: result.context.userId,
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
      const csv = toCsv(headers, rows.map((r) => headers.map((h) => r[h])))

      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="episodes_Q${quarter}_${year}.csv"`,
        },
      })
    }

    if (type === 'transcripts' || type === 'vtts') {
      // Every status that has a transcript — including compliance_checked, the
      // terminal state. The old ['transcribed','summarized'] filter matched
      // nothing once compliance ran, so every recent quarter returned 404.
      type Ep = { id: number; show_name: string | null; air_date: string | null; show_key: string | null }
      let episodes: Ep[]
      try {
        episodes = await fetchAllRows<Ep>('episodes', (from, to) =>
          supabase
            .from('episode_log')
            .select('id, show_name, air_date, show_key')
            .eq('station_id', stationId)
            .gte('air_date', start)
            .lte('air_date', end)
            .in('status', [...TRANSCRIBED_STATUSES])
            .order('air_date', { ascending: true })
            .order('id', { ascending: true })
            .range(from, to)
        )
      } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 500 })
      }

      if (!episodes.length) {
        return NextResponse.json(
          { error: 'No transcripts found for this quarter' },
          { status: 404 }
        )
      }

      const field = type === 'transcripts' ? 'transcript' : 'vtt'
      const ext = type === 'transcripts' ? 'txt' : 'vtt'
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.DOWNLOADS_EXPORT,
        operation: 'export',
        actorId: result.context.userId,
        stationId,
        resourceType: 'transcript',
        metadata: { type, year, quarter, episodeCount: episodes.length },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })

      // Streamed batch by batch: a full quarter of VTTs is ~2,000 × up to
      // ~225KB, too much to hold (and join) in memory at once. A plain
      // concatenated text file (zip would require a library).
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (let i = 0; i < episodes.length; i += TRANSCRIPT_BATCH) {
              const batch = episodes.slice(i, i + TRANSCRIPT_BATCH)
              // transcripts has no station_id; scope via the episode_log join.
              const { data, error: tErr } = await supabase
                .from('transcripts')
                .select(`episode_id, ${field}, episode_log!inner(station_id)`)
                .in('episode_id', batch.map((e) => e.id))
                .eq('episode_log.station_id', stationId)
              if (tErr) throw new Error(`Failed to load transcripts: ${tErr.message}`)
              const byId = new Map(
                ((data ?? []) as unknown as Array<Record<string, unknown>>).map((t) => [t.episode_id as number, t[field] as string | null])
              )
              for (const ep of batch) {
                const content = byId.get(ep.id)
                if (!content) continue
                const safeName = (ep.show_name ?? ep.show_key ?? `ep${ep.id}`).replace(/[^a-zA-Z0-9_-]/g, '_')
                controller.enqueue(encoder.encode(
                  `${'='.repeat(60)}\n` +
                  `FILE: ${safeName}_${ep.air_date}_${ep.id}.${ext}\n` +
                  `${'='.repeat(60)}\n\n` +
                  content + '\n\n'
                ))
              }
            }
            controller.close()
          } catch (err) {
            console.error('GET /api/downloads transcript stream failed:', err)
            controller.error(err)
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${type}_Q${quarter}_${year}.txt"`,
        },
      })
    }

    return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  } catch (err) {
    console.error('GET /api/downloads failed:', err)
    return NextResponse.json({ error: 'Failed to generate download' }, { status: 500 })
  }
}
