import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

/**
 * POST /api/shows/audit/process
 * Body: { episode_ids: number[] }
 *
 * This is the compliance-facing "complete the data" action: it does NOT
 * re-process episodes that are already done — it flags the incomplete ones as
 * `priority` so the batch workers complete them ahead of the general backlog,
 * and regardless of which quarter they aired in. Workers pick up episodes by
 * status from the DB, so we just need to:
 * 1. Flag every incomplete episode as priority
 * 2. Reset failed episodes to pending (priority included) so they re-enter the pipeline
 * 3. Trigger one batch job per stage that has work
 *
 * The workers will pick up the prioritized episodes on their own and clear the
 * flag once each reaches its terminal (compliance_checked) state.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const body = await request.json()
    const { episode_ids } = body as { episode_ids: number[] }

    if (!Array.isArray(episode_ids) || episode_ids.length === 0) {
      return NextResponse.json({ error: 'episode_ids array required' }, { status: 400 })
    }

    // Fetch current status for all requested episodes (scoped to station)
    const { data: episodes, error } = await supabase
      .from('episode_log')
      .select('id, status')
      .eq('station_id', stationId)
      .in('id', episode_ids)

    if (error) throw error

    const statuses = {
      pending: 0,
      failed: 0,
      transcribed: 0,
      summarized: 0,
      already_done: 0,
    }

    // Count what we have
    for (const ep of episodes ?? []) {
      if (ep.status === 'failed') statuses.failed++
      else if (ep.status === 'pending') statuses.pending++
      else if (ep.status === 'transcribed') statuses.transcribed++
      else if (ep.status === 'summarized') statuses.summarized++
      else statuses.already_done++
    }

    // Flag every incomplete episode (anything not already fully processed) as
    // priority so the workers complete them ahead of the backlog and regardless
    // of quarter. Already-done episodes are left untouched — we never re-process.
    const incompleteStatuses = new Set(['pending', 'failed', 'transcribed', 'summarized'])
    const incompleteIds = (episodes ?? [])
      .filter((ep) => incompleteStatuses.has(ep.status))
      .map((ep) => ep.id)
    if (incompleteIds.length > 0) {
      await supabase
        .from('episode_log')
        .update({ priority: true })
        .eq('station_id', stationId)
        .in('id', incompleteIds)
    }

    // Reset failed episodes to pending so workers will pick them up (they keep
    // the priority flag set above)
    const failedIds = (episodes ?? []).filter((ep) => ep.status === 'failed').map((ep) => ep.id)
    if (failedIds.length > 0) {
      await supabase
        .from('episode_log')
        .update({ status: 'pending', error_message: null })
        .eq('station_id', stationId)
        .in('id', failedIds)
    }

    // Trigger batch worker jobs for each stage that has work.
    // Workers query the DB for episodes in the right status, so we just
    // need one job per stage — no per-episode jobs needed.
    const triggered: string[] = []

    const needsTranscription = statuses.pending + statuses.failed
    if (needsTranscription > 0) {
      await transcribeQueue.add('audit-transcribe', { source: 'audit', chain: true, stationId })
      triggered.push(`transcribe (${needsTranscription} episodes)`)
    }

    if (statuses.transcribed > 0) {
      await summarizeQueue.add('audit-summarize', { source: 'audit', chain: true, stationId })
      triggered.push(`summarize (${statuses.transcribed} episodes)`)
    }

    if (statuses.summarized > 0) {
      await complianceQueue.add('audit-compliance', { source: 'audit', stationId })
      triggered.push(`compliance (${statuses.summarized} episodes)`)
    }

    const totalToProcess = needsTranscription + statuses.transcribed + statuses.summarized
    const message = totalToProcess > 0
      ? `Prioritized ${totalToProcess} episode${totalToProcess !== 1 ? 's' : ''} to complete: ${triggered.join(', ')}. Workers will run these ahead of the backlog and auto-continue through stages.`
      : 'All episodes are already fully processed!'

    return NextResponse.json({
      ok: true,
      message,
      statuses,
      triggered,
    })
  } catch (err) {
    console.error('POST /api/shows/audit/process failed:', err)
    return NextResponse.json({ error: 'Failed to queue processing jobs' }, { status: 500 })
  }
}
