import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue } from '@/lib/queue'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action } = body

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
    const [ingestCounts, transcribeCounts, summarizeCounts] = await Promise.all([
      getQueueCounts(ingestQueue),
      getQueueCounts(transcribeQueue),
      getQueueCounts(summarizeQueue),
    ])

    return NextResponse.json({
      ingest: ingestCounts,
      transcribe: transcribeCounts,
      summarize: summarizeCounts,
    })
  } catch (err) {
    console.error('GET /api/jobs failed:', err)
    return NextResponse.json({ error: 'Failed to fetch queue status' }, { status: 500 })
  }
}

async function getQueueCounts(queue: typeof ingestQueue) {
  const counts = await queue.getJobCounts()
  return {
    active: counts.active ?? 0,
    waiting: counts.waiting ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  }
}
