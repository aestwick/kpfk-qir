import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue } from '@/lib/queue'

export async function POST(request: NextRequest) {
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
}

export async function GET() {
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
