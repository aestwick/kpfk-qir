import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

/**
 * POST /api/shows/audit/process
 * Body: { episode_ids: number[], stages: ('transcribe' | 'summarize' | 'compliance')[] }
 *
 * Queues processing jobs for specific episodes. Only processes episodes that
 * are in the right status for the requested stage.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { episode_ids, stages } = body as { episode_ids: number[]; stages: string[] }

    if (!Array.isArray(episode_ids) || episode_ids.length === 0) {
      return NextResponse.json({ error: 'episode_ids array required' }, { status: 400 })
    }

    if (!Array.isArray(stages) || stages.length === 0) {
      return NextResponse.json({ error: 'stages array required (transcribe, summarize, compliance)' }, { status: 400 })
    }

    // Fetch current status for all requested episodes
    const { data: episodes, error } = await supabaseAdmin
      .from('episode_log')
      .select('id, status')
      .in('id', episode_ids)

    if (error) throw error

    const results = {
      transcribe: { queued: 0, skipped: 0, ids: [] as number[] },
      summarize: { queued: 0, skipped: 0, ids: [] as number[] },
      compliance: { queued: 0, skipped: 0, ids: [] as number[] },
    }

    for (const ep of episodes ?? []) {
      if (stages.includes('transcribe') && (ep.status === 'pending' || ep.status === 'failed')) {
        // Reset to pending and queue transcription
        await supabaseAdmin
          .from('episode_log')
          .update({ status: 'pending', error_message: null })
          .eq('id', ep.id)
        await transcribeQueue.add(`audit-transcribe-${ep.id}`, { episodeId: ep.id })
        results.transcribe.queued++
        results.transcribe.ids.push(ep.id)
      } else if (stages.includes('transcribe')) {
        results.transcribe.skipped++
      }

      if (stages.includes('summarize') && ep.status === 'transcribed') {
        await summarizeQueue.add(`audit-summarize-${ep.id}`, { episodeId: ep.id })
        results.summarize.queued++
        results.summarize.ids.push(ep.id)
      } else if (stages.includes('summarize')) {
        results.summarize.skipped++
      }

      if (stages.includes('compliance') && ep.status === 'summarized') {
        await complianceQueue.add(`audit-compliance-${ep.id}`, { episodeId: ep.id })
        results.compliance.queued++
        results.compliance.ids.push(ep.id)
      } else if (stages.includes('compliance')) {
        results.compliance.skipped++
      }
    }

    const totalQueued = results.transcribe.queued + results.summarize.queued + results.compliance.queued

    return NextResponse.json({
      ok: true,
      message: `Queued ${totalQueued} jobs across ${stages.join(', ')} stages`,
      results,
    })
  } catch (err) {
    console.error('POST /api/shows/audit/process failed:', err)
    return NextResponse.json({ error: 'Failed to queue processing jobs' }, { status: 500 })
  }
}
