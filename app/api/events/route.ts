import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

async function getQueueCounts(queue: typeof ingestQueue) {
  const counts = await queue.getJobCounts()
  return {
    active: counts.active ?? 0,
    waiting: counts.waiting ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  }
}

async function getEpisodeBacklog() {
  const { data, error } = await supabaseAdmin
    .from('episode_log')
    .select('status')
    .in('status', ['pending', 'transcribed', 'summarized', 'failed'])

  if (error || !data) return { pendingTranscription: 0, pendingSummarization: 0, pendingCompliance: 0, failed: 0 }

  return {
    pendingTranscription: data.filter((e: { status: string }) => e.status === 'pending').length,
    pendingSummarization: data.filter((e: { status: string }) => e.status === 'transcribed').length,
    pendingCompliance: data.filter((e: { status: string }) => e.status === 'summarized').length,
    failed: data.filter((e: { status: string }) => e.status === 'failed').length,
  }
}

export async function GET() {
  const encoder = new TextEncoder()

  // Shared cleanup state — accessible from both start() and cancel()
  let closed = false
  let interval: ReturnType<typeof setInterval> | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null

  const stream = new ReadableStream({
    async start(controller) {
      async function push() {
        if (closed) return
        try {
          const [ingest, transcribe, summarize, compliance, backlog] = await Promise.all([
            getQueueCounts(ingestQueue),
            getQueueCounts(transcribeQueue),
            getQueueCounts(summarizeQueue),
            getQueueCounts(complianceQueue),
            getEpisodeBacklog(),
          ])

          const data = { ingest, transcribe, summarize, compliance, backlog }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Silently skip on error — client will reconnect
        }
      }

      // Send initial data immediately
      await push()

      // Then push every 5 seconds
      interval = setInterval(push, 5000)

      // Clean up after 5 minutes (client will reconnect)
      timeout = setTimeout(() => {
        closed = true
        if (interval) clearInterval(interval)
        controller.close()
      }, 5 * 60 * 1000)

      controller.enqueue(encoder.encode('event: connected\ndata: {}\n\n'))
    },
    cancel() {
      // Clean up when client disconnects
      closed = true
      if (interval) clearInterval(interval)
      if (timeout) clearTimeout(timeout)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
