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

    const results = await Promise.all(
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
    )

    const data: Record<string, unknown> = {}
    for (const result of results) {
      data[result.name] = {
        ...result.counts,
        failedJobs: result.failedJobs,
      }
    }

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
