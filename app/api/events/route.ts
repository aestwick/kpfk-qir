import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

async function getQueueCounts(queue: typeof ingestQueue) {
  const [counts, activeJobs] = await Promise.all([
    queue.getJobCounts(),
    queue.getActive(0, 5),
  ])
  return {
    active: counts.active ?? 0,
    waiting: counts.waiting ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    activeJobs: activeJobs.map((j: any) => ({
      id: j.id,
      name: j.name,
      progress: j.progress ?? null,
      processedOn: j.processedOn ?? null,
    })),
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
