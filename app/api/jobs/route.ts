import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

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
          const [counts, failed] = await Promise.all([
            queue.getJobCounts(),
            queue.getFailed(0, 20),
          ])
          return {
            name,
            counts: {
              active: counts.active ?? 0,
              waiting: counts.waiting ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
            },
            failedJobs: failed.map((job) => ({
              id: job.id,
              name: job.name,
              data: job.data,
              failedReason: job.failedReason,
              timestamp: job.timestamp,
              finishedOn: job.finishedOn,
            })),
          }
        })
      ),
      (() => {
        const now = new Date()
        const q = Math.floor(now.getMonth() / 3)
        const year = now.getFullYear()
        const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
        const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)
        return supabaseAdmin
          .from('episode_log')
          .select('status')
          .in('status', ['pending', 'transcribed', 'summarized', 'failed'])
          .gte('air_date', start)
          .lte('air_date', end)
      })(),
    ])

    const episodes = backlogResult.data ?? []
    const backlog = {
      pendingTranscription: episodes.filter((e: { status: string }) => e.status === 'pending').length,
      pendingSummarization: episodes.filter((e: { status: string }) => e.status === 'transcribed').length,
      pendingCompliance: episodes.filter((e: { status: string }) => e.status === 'summarized').length,
      failed: episodes.filter((e: { status: string }) => e.status === 'failed').length,
    }

    const data: Record<string, unknown> = {}
    for (const result of results) {
      data[result.name] = {
        ...result.counts,
        failedJobs: result.failedJobs,
      }
    }
    data.backlog = backlog

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
