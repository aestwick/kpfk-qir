import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    const format = searchParams.get('format') ?? 'csv'

    if (!id) {
      return NextResponse.json({ error: 'id required' }, { status: 400 })
    }

    const { data: draft, error } = await supabase
      .from('qir_drafts')
      .select('*')
      .eq('id', parseInt(id))
      .eq('station_id', stationId)
      .single()

    if (error || !draft) {
      return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    }

    if (format === 'csv' || format === 'text') {
      const meta = requestMeta(request)
      void logAuditEvent({
        action: AUDIT_ACTIONS.REPORT_EXPORT,
        operation: 'export',
        actorId: result.context.userId,
        stationId,
        resourceType: 'qir_draft',
        resourceId: draft.id,
        metadata: { format, year: draft.year, quarter: draft.quarter, version: draft.version },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
    }

    const entries = (draft.curated_entries ?? []) as Array<{
      episode_id: number
      show_name: string
      host: string
      air_date: string
      start_time: string
      duration: number
      headline: string
      guest: string
      summary: string
      issue_category: string
    }>

    if (format === 'csv') {
      const headers = [
        'Issue Category',
        'Program',
        'Host',
        'Air Date',
        'Time',
        'Duration (min)',
        'Topic',
        'Guest(s)',
        'Description',
      ]

      const csvLines = [
        headers.join(','),
        ...entries.map((e) =>
          [
            e.issue_category,
            e.show_name,
            e.host,
            e.air_date,
            e.start_time,
            String(e.duration),
            e.headline,
            e.guest,
            e.summary,
          ]
            .map((val) => {
              const s = String(val ?? '')
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"`
                : s
            })
            .join(',')
        ),
      ]

      return new Response(csvLines.join('\n'), {
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': `attachment; filename="QIR_Q${draft.quarter}_${draft.year}_v${draft.version}.csv"`,
        },
      })
    }

    if (format === 'text') {
      const text = draft.curated_text ?? draft.full_text ?? ''
      return new Response(text, {
        headers: {
          'Content-Type': 'text/plain',
          'Content-Disposition': `attachment; filename="QIR_Q${draft.quarter}_${draft.year}_v${draft.version}.txt"`,
        },
      })
    }

    return NextResponse.json({ error: 'Unsupported format. Use csv or text.' }, { status: 400 })
  } catch (err) {
    console.error('GET /api/qir/export failed:', err)
    return NextResponse.json({ error: 'Failed to export draft' }, { status: 500 })
  }
}
