import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

/**
 * POST /api/shows/audit/process
 * Body: { episode_ids: number[] }
 *
 * Prepares episodes for processing by resetting statuses, then triggers
 * batch worker jobs. Workers are batch processors — they pick up episodes
 * by status from the DB, so we just need to:
 * 1. Reset failed episodes to pending
 * 2. Trigger one batch job per stage that has work
 *
 * The workers will pick up the episodes on their own.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { episode_ids } = body as { episode_ids: number[] }

    if (!Array.isArray(episode_ids) || episode_ids.length === 0) {
      return NextResponse.json({ error: 'episode_ids array required' }, { status: 400 })
    }

    // Fetch current status for all requested episodes
    const { data: episodes, error } = await supabaseAdmin
      .from('episode_log')
      .select('id, status')
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

    // Reset failed episodes to pending so workers will pick them up
    const failedIds = (episodes ?? []).filter((ep) => ep.status === 'failed').map((ep) => ep.id)
    if (failedIds.length > 0) {
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'pending', error_message: null })
        .in('id', failedIds)
    }

    // Trigger batch worker jobs for each stage that has work.
    // Workers query the DB for episodes in the right status, so we just
    // need one job per stage — no per-episode jobs needed.
    const triggered: string[] = []

    const needsTranscription = statuses.pending + statuses.failed
    if (needsTranscription > 0) {
      await transcribeQueue.add('audit-transcribe', { source: 'audit', chain: true })
      triggered.push(`transcribe (${needsTranscription} episodes)`)
    }

    if (statuses.transcribed > 0) {
      await summarizeQueue.add('audit-summarize', { source: 'audit', chain: true })
      triggered.push(`summarize (${statuses.transcribed} episodes)`)
    }

    if (statuses.summarized > 0) {
      await complianceQueue.add('audit-compliance', { source: 'audit' })
      triggered.push(`compliance (${statuses.summarized} episodes)`)
    }

    const totalToProcess = needsTranscription + statuses.transcribed + statuses.summarized
    const message = totalToProcess > 0
      ? `Processing ${totalToProcess} episodes: ${triggered.join(', ')}. Workers will auto-continue through stages.`
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
