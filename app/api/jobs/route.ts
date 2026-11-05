import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue, discoverSyncQueue } from '@/lib/queue'
import { jobPriority } from '@/lib/tier'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { isPipelinePaused, isStationPaused, invalidateSetting } from '@/lib/settings'
import { jobActionAccess } from '@/lib/job-actions'
import { setGlobalPaused, setStationPaused, sweepFailedJobs, isPipelineQueueName } from '@/lib/pipeline-control'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const ctx = await getStationContext(request)
    if (ctx.error) return stationErrorResponse(ctx.error)
    const { supabase, stationId } = ctx.context

    const denied = requireRole(ctx.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { action } = body

    // Platform-wide controls (the all-stations kill switch, the shared worker
    // concurrency mode) are super-admin only; everything else here acts on the
    // active station alone. See lib/job-actions.ts for the table.
    if (jobActionAccess(action) === 'super' && !ctx.context.isSuperAdmin) {
      return NextResponse.json(
        { error: 'Only a super-admin can change settings that affect every station' },
        { status: 403 }
      )
    }

    // Pause/resume THIS station only (station_settings). Other stations keep
    // running. The worker reads global OR station, so this is all it takes.
    if (action === 'pause_pipeline' || action === 'resume_pipeline') {
      const paused = action === 'pause_pipeline'
      await setStationPaused(stationId, paused)
      return NextResponse.json({
        ok: true,
        message: paused ? 'This station is paused' : 'This station is resumed',
        paused,
        scope: 'station',
      })
    }

    // Global kill switch — every station (super-admin, gated above).
    if (action === 'pause_all' || action === 'resume_all') {
      const paused = action === 'pause_all'
      await setGlobalPaused(paused)
      return NextResponse.json({
        ok: true,
        message: paused ? 'All stations paused' : 'All-stations pause lifted',
        paused,
        scope: 'all',
      })
    }

    // Pipeline mode toggle — shared worker pool, so every station (super-admin).
    if (action === 'set_pipeline_mode') {
      const { mode } = body
      if (mode !== 'steady' && mode !== 'catch-up') {
        return NextResponse.json({ error: 'Invalid mode. Use "steady" or "catch-up"' }, { status: 400 })
      }
      const { error } = await supabaseAdmin
        .from('qir_settings')
        .upsert({ key: 'pipeline_mode', value: JSON.stringify(mode), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw error
      invalidateSetting('pipeline_mode')
      return NextResponse.json({ ok: true, message: `Pipeline mode set to ${mode}` })
    }

    // Retry / clear failed jobs — the BullMQ queues are shared by every
    // station, so only touch jobs that belong to the active station (same
    // filter Master Control uses for its per-station sweep).
    if (action === 'retry_failed' || action === 'clear_failed') {
      if (body.queue !== undefined && !isPipelineQueueName(body.queue)) {
        return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
      }
      const count = await sweepFailedJobs({
        action: action === 'retry_failed' ? 'retry' : 'clear',
        queues: body.queue ? [body.queue] : undefined,
        stationId,
      })
      const verb = action === 'retry_failed' ? 'Retried' : 'Cleared'
      const where = body.queue ? ` ${body.queue}` : ''
      return NextResponse.json({ ok: true, message: `${verb} ${count} failed${where} job(s) for this station`, count })
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
        supabase.from('episode_log').select('id', { count: 'exact', head: true }).eq('station_id', stationId).eq('status', 'pending').or(dateFilter),
        supabase.from('episode_log').select('id', { count: 'exact', head: true }).eq('station_id', stationId).eq('status', 'transcribed').or(dateFilter),
        supabase.from('episode_log').select('id', { count: 'exact', head: true }).eq('station_id', stationId).eq('status', 'summarized').or(dateFilter),
      ])

      const triggered: string[] = []
      const priority = await jobPriority(stationId)

      // Always run ingest to pull any new episodes
      await ingestQueue.add('pipeline-ingest', { stationId })
      triggered.push('ingest')

      if ((pendingRes.count ?? 0) > 0) {
        await transcribeQueue.add('pipeline-transcribe', { stationId }, { priority })
        triggered.push(`transcribe (${pendingRes.count} pending)`)
      }
      if ((transcribedRes.count ?? 0) > 0) {
        await summarizeQueue.add('pipeline-summarize', { stationId }, { priority })
        triggered.push(`summarize (${transcribedRes.count} transcribed)`)
      }
      if ((summarizedRes.count ?? 0) > 0) {
        await complianceQueue.add('pipeline-compliance', { stationId }, { priority })
        triggered.push(`compliance (${summarizedRes.count} summarized)`)
      }

      const total = (pendingRes.count ?? 0) + (transcribedRes.count ?? 0) + (summarizedRes.count ?? 0)
      const message = total > 0
        ? `Pipeline advancing: ${triggered.join(', ')}. ${total} episodes to process — jobs will auto-continue until done.`
        : 'Pipeline up to date! Ingest queued to check for new episodes.'

      return NextResponse.json({ ok: true, message, triggered, backlog: total })
    }

    const priority = await jobPriority(stationId)
    switch (action) {
      case 'ingest': {
        await ingestQueue.add('manual-ingest', { stationId })
        return NextResponse.json({ ok: true, message: 'Ingest job queued' })
      }
      case 'transcribe': {
        await transcribeQueue.add('manual-transcribe', { stationId }, { priority })
        return NextResponse.json({ ok: true, message: 'Transcribe job queued' })
      }
      case 'summarize': {
        await summarizeQueue.add('manual-summarize', { stationId }, { priority })
        return NextResponse.json({ ok: true, message: 'Summarize job queued' })
      }
      case 'discover-sync': {
        // Import this station's archive program list as inactive show_keys now,
        // rather than waiting for the daily cron.
        await discoverSyncQueue.add('manual-discover-sync', { stationId })
        return NextResponse.json({ ok: true, message: 'Archive show-key sync queued' })
      }
      case 'backfill-categories': {
        // Re-resolve <category> from each feed for show_keys that never got one
        // (e.g. added via "Discover from archive", which carries key+name only).
        // The category is what the excluded_categories pull/coverage filters match.
        await discoverSyncQueue.add('manual-backfill-categories', { stationId, backfill: true })
        return NextResponse.json({ ok: true, message: 'Category backfill queued — re-resolving uncategorized shows from their feeds' })
      }
      case 'compliance': {
        const showKey = body.show_key as string | undefined
        if (showKey) {
          // Count eligible episodes for this show
          const { count } = await supabase
            .from('episode_log')
            .select('id', { count: 'exact', head: true })
            .eq('station_id', stationId)
            .eq('show_key', showKey)
            .eq('status', 'summarized')
          await complianceQueue.add(`manual-compliance-${showKey}`, { show_key: showKey, stationId }, { priority })
          return NextResponse.json({ ok: true, message: `Compliance check queued for show "${showKey}" (${count ?? 0} episodes eligible)` })
        }
        await complianceQueue.add('manual-compliance', { stationId }, { priority })
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

export async function GET(request: NextRequest) {
  try {
    const ctx = await getStationContext(request)
    if (ctx.error) return stationErrorResponse(ctx.error)
    const { supabase, stationId } = ctx.context

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
            // Only this station's failures: retry/clear act on these alone.
            failedJobs: failed.filter((job: any) => job.data?.stationId === stationId).map((job: any) => ({
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
      })(),
    ])

    const backlog = backlogResult

    // Global kill switch and this station's own flag, reported separately so
    // the UI can say which one is on (effective = either).
    const [globalPaused, stationPaused] = await Promise.all([
      isPipelinePaused(),
      isStationPaused(stationId),
    ])

    const data: Record<string, unknown> = {}
    for (const result of results) {
      data[result.name] = {
        ...result.counts,
        failedJobs: result.failedJobs,
        jobs: result.jobs,
      }
    }
    data.backlog = backlog
    data.pipeline_paused = globalPaused || stationPaused
    data.pipeline_paused_global = globalPaused
    data.pipeline_paused_station = stationPaused

    return NextResponse.json(data)
  } catch (err) {
    console.error('GET /api/jobs failed:', err)
    return NextResponse.json({ error: 'Failed to fetch queue status' }, { status: 500 })
  }
}

