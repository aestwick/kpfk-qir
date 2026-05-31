import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { transcribeQueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

/**
 * POST /api/shows/audit/resolve
 * Body: { episode_ids: number[], action: 'retry' | 'drop' }
 *
 * Escape hatch for episodes the pipeline has given up on (status 'failed' with
 * exhausted retries, or 'dead' after the auto-retry cron promotes them). These
 * never re-enter processing on their own, so the audit surfaces them with two
 * options:
 *
 *  - retry: reset retry_count and re-prioritize, giving the episode a fresh
 *    attempt budget at the front of the queue (regardless of quarter).
 *  - drop:  move the episode to the terminal 'dead' state and clear priority,
 *    so it's excluded from processing and the QIR without further retries.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { episode_ids, action } = body as { episode_ids: number[]; action: 'retry' | 'drop' }

    if (!Array.isArray(episode_ids) || episode_ids.length === 0) {
      return NextResponse.json({ error: 'episode_ids array required' }, { status: 400 })
    }
    if (action !== 'retry' && action !== 'drop') {
      return NextResponse.json({ error: "action must be 'retry' or 'drop'" }, { status: 400 })
    }

    if (action === 'retry') {
      // Fresh attempt budget (retry_count: 0) + priority, re-entering at the
      // transcribe stage so the whole pipeline re-runs from scratch.
      const { data: updated, error } = await supabase
        .from('episode_log')
        .update({ status: 'pending', error_message: null, retry_count: 0, priority: true, updated_at: new Date().toISOString() })
        .eq('station_id', stationId)
        .in('id', episode_ids)
        .select('id')
      if (error) throw error

      const count = updated?.length ?? 0
      if (count > 0) {
        await transcribeQueue.add('audit-retry', { source: 'audit', chain: true, stationId })
      }
      return NextResponse.json({
        ok: true,
        action,
        count,
        message: count > 0
          ? `Retrying ${count} episode${count !== 1 ? 's' : ''} with a fresh attempt budget — prioritized ahead of the backlog.`
          : 'No matching episodes to retry.',
      })
    }

    // action === 'drop'
    const { data: updated, error } = await supabase
      .from('episode_log')
      .update({ status: 'dead', priority: false, error_message: 'Dropped during show audit', updated_at: new Date().toISOString() })
      .eq('station_id', stationId)
      .in('id', episode_ids)
      .select('id')
    if (error) throw error

    const count = updated?.length ?? 0
    return NextResponse.json({
      ok: true,
      action,
      count,
      message: count > 0
        ? `Dropped ${count} episode${count !== 1 ? 's' : ''} — excluded from processing and the report.`
        : 'No matching episodes to drop.',
    })
  } catch (err) {
    console.error('POST /api/shows/audit/resolve failed:', err)
    return NextResponse.json({ error: 'Failed to resolve episodes' }, { status: 500 })
  }
}
