import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'
import { isPipelinePaused } from '@/lib/settings'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

    // Pipeline pause/resume
    if (action === 'pause_pipeline' || action === 'resume_pipeline') {
      const paused = action === 'pause_pipeline'
      const { error } = await supabaseAdmin
        .from('qir_settings')
        .upsert({ key: 'pipeline_paused', value: JSON.stringify(paused), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw error
      return NextResponse.json({ ok: true, message: paused ? 'Pipeline paused' : 'Pipeline resumed', paused })
    }

    // Pipeline mode toggle
    if (action === 'set_pipeline_mode') {
      const { mode } = body
      if (mode !== 'steady' && mode !== 'catch-up') {
        return NextResponse.json({ error: 'Invalid mode. Use "steady" or "catch-up"' }, { status: 400 })
      }
      const { error } = await supabaseAdmin
        .from('qir_settings')
        .upsert({ key: 'pipeline_mode', value: JSON.stringify(mode), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw error
      return NextResponse.json({ ok: true, message: `Pipeline mode set to ${mode}` })
    }

    // Clear failed jobs from a queue
    if (action === 'clear_failed') {
      const queue = getQueue(body.queue)
      if (!queue) return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
      await queue.clean(0, 0, 'failed')
      return NextResponse.json({ ok: true, message: `Cleared failed jobs from ${body.queue}` })
    }

    // Retry all failed jobs in a queue
    if (action === 'retry_failed') {
      const queue = getQueue(body.queue)
      if (!queue) return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
      const failed = await queue.getFailed(0, 100)
      let retried = 0
      for (const job of failed) {
        try {
          await job.retry()
          retried++
        } catch {
          // Job may have been removed or already retried — skip
        }
      }
      return NextResponse.json({ ok: true, message: `Retried ${retried} of ${failed.length} failed jobs in ${body.queue}` })
    }

    // Advance pipeline: check backlog and trigger all stages with pending work
    if (action === 'advance-pipeline') {
      const now = new Date()
      const q = Math.floor(now.getMonth() / 3)
      const year = now.getFullYear()
      const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
      const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)
      const dateFilter = `and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`

      const [pendingRes, transcribedRes, summarizedRes] = await Promise.all([
        supabaseAdmin.from('episode_log').select('id', { count: 'exact', head: true }).eq('status', 'pending').or(dateFilter),
        supabaseAdmin.from('episode_log').select('id', { count: 'exact', head: true }).eq('status', 'transcribed').or(dateFilter),
        supabaseAdmin.from('episode_log').select('id', { count: 'exact', head: true }).eq('status', 'summarized').or(dateFilter),
      ])

      const triggered: string[] = []

      // Always run ingest to pull any new episodes
      await ingestQueue.add('pipeline-ingest', {})
      triggered.push('ingest')

      if ((pendingRes.count ?? 0) > 0) {
        await transcribeQueue.add('pipeline-transcribe', {})
        triggered.push(`transcribe (${pendingRes.count} pending)`)
      }
      if ((transcribedRes.count ?? 0) > 0) {
        await summarizeQueue.add('pipeline-summarize', {})
        triggered.push(`summarize (${transcribedRes.count} transcribed)`)
      }
      if ((summarizedRes.count ?? 0) > 0) {
        await complianceQueue.add('pipeline-compliance', {})
        triggered.push(`compliance (${summarizedRes.count} summarized)`)
      }

      const total = (pendingRes.count ?? 0) + (transcribedRes.count ?? 0) + (summarizedRes.count ?? 0)
      const message = total > 0
        ? `Pipeline advancing: ${triggered.join(', ')}. ${total} episodes to process — jobs will auto-continue until done.`
        : 'Pipeline up to date! Ingest queued to check for new episodes.'

      return NextResponse.json({ ok: true, message, triggered, backlog: total })
    }

    switch (action) {
      case 'ingest': {
        await ingestQueue.add('manual-ingest', {})
        return NextResponse.json({ ok: true, message: 'Ingest job queued' })
      }
      case 'transcribe': {
        await transcribeQueue.add('manual-transcribe', {})
        return NextResponse.json({ ok: true, message: 'Transcribe job queued' })
      }
      case 'summarize': {
        await summarizeQueue.add('manual-summarize', {})
        return NextResponse.json({ ok: true, message: 'Summarize job queued' })
      }
      case 'compliance': {
        const showKey = body.show_key as string | undefined
        if (showKey) {
          // Count eligible episodes for this show
          const { count } = await supabaseAdmin
            .from('episode_log')
            .select('id', { count: 'exact', head: true })
            .eq('show_key', showKey)
            .eq('status', 'summarized')
          await complianceQueue.add(`manual-compliance-${showKey}`, { show_key: showKey })
          return NextResponse.json({ ok: true, message: `Compliance check queued for show "${showKey}" (${count ?? 0} episodes eligible)` })
        }
        await complianceQueue.add('manual-compliance', {})
        return NextResponse.json({ ok: true, message: 'Compliance check job queued' })
      }
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (err) {
    console.error('POST /api/jobs failed:', err)
    return NextResponse.json({ error: 'Failed to queue job' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const queues = { ingest: ingestQueue, transcribe: transcribeQueue, summarize: summarizeQueue, compliance: complianceQueue }
    const queueNames = Object.keys(queues) as (keyof typeof queues)[]

    // Fetch BullMQ counts and episode backlog in parallel
    const [results, backlogResult] = await Promise.all([
      Promise.all(
        queueNames.map(async (name) => {
          const queue = queues[name]
          const [counts, failed, active, waiting, completed] = await Promise.all([
            queue.getJobCounts(),
            queue.getFailed(0, 20),
            queue.getActive(0, 20),
            queue.getWaiting(0, 20),
            queue.getCompleted(0, 30),
          ])
          const mapJob = (job: { id: string | undefined; name: string; data: Record<string, unknown>; timestamp: number; processedOn?: number | null; finishedOn?: number | null; failedReason?: string; progress?: unknown; returnvalue?: unknown }, state: string) => ({
            id: job.id,
            name: job.name,
            data: job.data,
            state,
            timestamp: job.timestamp,
            processedOn: job.processedOn ?? null,
            finishedOn: job.finishedOn ?? null,
            failedReason: state === 'failed' ? job.failedReason : undefined,
            progress: job.progress ?? null,
            returnvalue: state === 'completed' ? job.returnvalue ?? null : null,
          })
          return {
            name,
            counts: {
              active: counts.active ?? 0,
              waiting: counts.waiting ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
            },
            failedJobs: failed.map((job: any) => ({
              id: job.id,
              name: job.name,
              data: job.data,
              failedReason: job.failedReason,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn,
            })),
            jobs: [
              ...active.map((j: any) => mapJob(j, 'active')),
              ...waiting.map((j: any) => mapJob(j, 'waiting')),
              ...completed.map((j: any) => mapJob(j, 'completed')),
            ],
          }
        })
      ),
      (async () => {
        const now = new Date()
        const q = Math.floor(now.getMonth() / 3)
        const year = now.getFullYear()
        const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
        const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)

        // Use count queries to avoid Supabase's default 1000-row limit
        const baseQuery = () => supabaseAdmin.from('episode_log').select('id', { count: 'exact', head: true }).gte('air_date', start).lte('air_date', end)

        const [pending, transcribed, summarized, complianceChecked, failed, total] = await Promise.all([
          baseQuery().eq('status', 'pending'),
          baseQuery().eq('status', 'transcribed'),
          baseQuery().eq('status', 'summarized'),
          baseQuery().eq('status', 'compliance_checked'),
          baseQuery().eq('status', 'failed'),
          baseQuery(),
        ])

        const pendingCount = pending.count ?? 0
        const transcribedCount = transcribed.count ?? 0
        const summarizedCount = summarized.count ?? 0
        const complianceCheckedCount = complianceChecked.count ?? 0
        const failedCount = failed.count ?? 0
        const totalCount = total.count ?? 0

        return {
          pendingTranscription: pendingCount,
          pendingSummarization: transcribedCount,
          pendingCompliance: summarizedCount,
          failed: failedCount,
          episodeCounts: {
            ingested: totalCount,
            transcribed: transcribedCount + summarizedCount + complianceCheckedCount,
            summarized: summarizedCount + complianceCheckedCount,
            complianceChecked: complianceCheckedCount,
            failed: failedCount,
          },
        }
      })(),
    ])

    const backlog = backlogResult

    const paused = await isPipelinePaused()

    const data: Record<string, unknown> = {}
    for (const result of results) {
      data[result.name] = {
        ...result.counts,
        failedJobs: result.failedJobs,
        jobs: result.jobs,
      }
    }
    data.backlog = backlog
    data.pipeline_paused = paused

    return NextResponse.json(data)
  } catch (err) {
    console.error('GET /api/jobs failed:', err)
    return NextResponse.json({ error: 'Failed to fetch queue status' }, { status: 500 })
  }
}

function getQueue(name: string) {
  switch (name) {
    case 'ingest': return ingestQueue
    case 'transcribe': return transcribeQueue
    case 'summarize': return summarizeQueue
    case 'compliance': return complianceQueue
    default: return null
  }
}
