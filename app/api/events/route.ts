import { ingestQueue, transcribeQueue, summarizeQueue } from '@/lib/queue'

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

export async function GET() {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false

      async function push() {
        if (closed) return
        try {
          const [ingest, transcribe, summarize] = await Promise.all([
            getQueueCounts(ingestQueue),
            getQueueCounts(transcribeQueue),
            getQueueCounts(summarizeQueue),
          ])

          const data = { ingest, transcribe, summarize }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Silently skip on error — client will reconnect
        }
      }

      // Send initial data immediately
      await push()

      // Then push every 5 seconds
      const interval = setInterval(push, 5000)

      // Clean up after 5 minutes (client will reconnect)
      const timeout = setTimeout(() => {
        closed = true
        clearInterval(interval)
        controller.close()
      }, 5 * 60 * 1000)

      // Handle client disconnect
      controller.enqueue(encoder.encode(': connected\n\n'))
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
