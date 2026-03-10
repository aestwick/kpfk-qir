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

function getCurrentQuarterBounds() {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const year = now.getFullYear()
  const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
  const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)
  return { start, end }
}

async function getEpisodeBacklog() {
  const { start, end } = getCurrentQuarterBounds()
  const { data, error } = await supabaseAdmin
    .from('episode_log')
    .select('status')
    .gte('air_date', start)
    .lte('air_date', end)

  if (error || !data) return {
    pendingTranscription: 0, pendingSummarization: 0, pendingCompliance: 0, failed: 0,
    episodeCounts: { ingested: 0, transcribed: 0, summarized: 0, complianceChecked: 0, failed: 0 },
  }

  const statuses: string[] = data.map((e: { status: string }) => e.status)

  return {
    pendingTranscription: statuses.filter((s: string) => s === 'pending').length,
    pendingSummarization: statuses.filter((s: string) => s === 'transcribed').length,
    pendingCompliance: statuses.filter((s: string) => s === 'summarized').length,
    failed: statuses.filter((s: string) => s === 'failed').length,
    episodeCounts: {
      ingested: statuses.length,
      transcribed: statuses.filter((s: string) => s === 'transcribed' || s === 'summarized' || s === 'compliance_checked').length,
      summarized: statuses.filter((s: string) => s === 'summarized' || s === 'compliance_checked').length,
      complianceChecked: statuses.filter((s: string) => s === 'compliance_checked').length,
      failed: statuses.filter((s: string) => s === 'failed').length,
    },
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
