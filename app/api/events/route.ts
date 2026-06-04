import { NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { withStationAuth } from '@/lib/auth'
import { getCurrentQuarterBounds } from '@/lib/quarters'

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

async function getEpisodeBacklog(supabase: SupabaseClient, stationId: string) {
  const { start, end } = getCurrentQuarterBounds()

  // Per-station backlog. Uses the request-scoped (RLS) client plus an explicit
  // station filter; head:true count queries avoid Supabase's default 1000-row cap.
  const baseQuery = () => supabase.from('episode_log').select('id', { count: 'exact', head: true }).eq('station_id', stationId).gte('air_date', start).lte('air_date', end)

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

export const GET = withStationAuth(async (ctx) => {
  // Authenticated like every other Phase E route: the client consumes this
  // stream via fetch() (not EventSource), so it can send a Bearer token.
  const { supabase, stationId } = ctx

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
          // NOTE: queue counts are a GLOBAL pipeline-health metric. BullMQ runs
          // one shared queue per stage (the plan forbids per-station queues), so
          // these depths are network-wide, not per-station. Only `backlog` is
          // station-scoped. Acceptable for a single-operator Pacifica network.
          const [ingest, transcribe, summarize, compliance, backlog] = await Promise.all([
            getQueueCounts(ingestQueue),
            getQueueCounts(transcribeQueue),
            getQueueCounts(summarizeQueue),
            getQueueCounts(complianceQueue),
            getEpisodeBacklog(supabase, stationId),
          ])

          const data = { ingest, transcribe, summarize, compliance, backlog }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch (err) {
          // Skip this tick but surface the error (no silent swallow); the client
          // keeps the previous snapshot and the next tick/reconnect retries.
          console.error('[events] failed to push update:', err)
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

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})
