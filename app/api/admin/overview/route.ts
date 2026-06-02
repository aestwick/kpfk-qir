import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse, StationContext } from '@/lib/auth'
import { getSetting, invalidateSetting, isStationPaused } from '@/lib/settings'

export const dynamic = 'force-dynamic'

// Super-admin master control: a cross-tenant view of every station's pipeline,
// with per-station pause/resume, run-now, and failed-job retry/clear. This is the
// one place that intentionally reaches across stations, so it hard-gates on
// isSuperAdmin (RLS would otherwise scope reads to memberships) and uses the
// service-role client for the cross-tenant aggregation.

const QUEUES = { ingest: ingestQueue, transcribe: transcribeQueue, summarize: summarizeQueue, compliance: complianceQueue }
type QueueName = keyof typeof QUEUES
const EPISODE_STATUSES = ['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed'] as const

function currentQuarterBounds(): { start: string; end: string } {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const year = now.getFullYear()
  const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
  const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)
  return { start, end }
}

type Guarded =
  | { context: StationContext; error?: undefined }
  | { context?: undefined; error: NextResponse }

async function requireSuperAdmin(request: NextRequest): Promise<Guarded> {
  const result = await getStationContext(request)
  if (result.error) return { error: stationErrorResponse(result.error) }
  // Hard gate: super-admins only. Mirrors /api/audit — fail loud, nav-hiding is
  // never the only guard.
  if (!result.context.isSuperAdmin) {
    return { error: NextResponse.json({ error: 'Master control is restricted to super-admins' }, { status: 403 }) }
  }
  return { context: result.context }
}

// Recent jobs across a queue, tagged with the station they belong to so the
// master view can group activity per station. Mirrors the job shape /api/jobs
// returns, plus `queue` and `stationId`.
function mapJob(queue: QueueName, job: any, state: string) {
  return {
    queue,
    id: job.id,
    name: job.name,
    state,
    stationId: (job.data?.stationId as string | undefined) ?? null,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    failedReason: state === 'failed' ? job.failedReason : undefined,
    progress: job.progress ?? null,
  }
}

export async function GET(request: NextRequest) {
  try {
    const guard = await requireSuperAdmin(request)
    if (guard.error) return guard.error

    const { start, end } = currentQuarterBounds()

    // All stations (service-role; this is an admin cross-tenant view).
    const { data: stations, error: stationsErr } = await supabaseAdmin
      .from('stations')
      .select('id, slug, name')
      .order('name')
    if (stationsErr) throw stationsErr
    const stationList = stations ?? []

    const queueNames = Object.keys(QUEUES) as QueueName[]

    const [globalPaused, mode, stationPauseStates, episodeCounts, queueData] = await Promise.all([
      // Global master flag.
      getSetting<boolean>('pipeline_paused').then((v) => v === true),
      getSetting<string>('pipeline_mode').then((v) => v ?? 'steady'),
      // Each station's own pause override.
      Promise.all(stationList.map((s) => isStationPaused(s.id))),
      // Per-station episode counts for the current quarter.
      Promise.all(
        stationList.map(async (s) => {
          const base = () =>
            supabaseAdmin
              .from('episode_log')
              .select('id', { count: 'exact', head: true })
              .eq('station_id', s.id)
              .gte('air_date', start)
              .lte('air_date', end)
          const [pending, transcribed, summarized, checked, failed, total] = await Promise.all([
            base().eq('status', 'pending'),
            base().eq('status', 'transcribed'),
            base().eq('status', 'summarized'),
            base().eq('status', 'compliance_checked'),
            base().eq('status', 'failed'),
            base(),
          ])
          return {
            pending: pending.count ?? 0,
            transcribed: transcribed.count ?? 0,
            summarized: summarized.count ?? 0,
            compliance_checked: checked.count ?? 0,
            failed: failed.count ?? 0,
            total: total.count ?? 0,
          }
        })
      ),
      // Queue-level counts + recent jobs (tagged with stationId).
      Promise.all(
        queueNames.map(async (name) => {
          const queue = QUEUES[name]
          const [counts, active, waiting, failed, completed] = await Promise.all([
            queue.getJobCounts(),
            queue.getActive(0, 50),
            queue.getWaiting(0, 50),
            queue.getFailed(0, 50),
            queue.getCompleted(0, 30),
          ])
          const jobs = [
            ...active.map((j: any) => mapJob(name, j, 'active')),
            ...waiting.map((j: any) => mapJob(name, j, 'waiting')),
            ...failed.map((j: any) => mapJob(name, j, 'failed')),
            ...completed.map((j: any) => mapJob(name, j, 'completed')),
          ]
          return {
            name,
            counts: {
              active: counts.active ?? 0,
              waiting: counts.waiting ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
            },
            jobs,
          }
        })
      ),
    ])

    // Flatten jobs and tally in-flight (active/waiting/failed) activity per station.
    const allJobs = queueData.flatMap((q) => q.jobs)
    const activityByStation = new Map<string, { active: number; waiting: number; failed: number }>()
    for (const j of allJobs) {
      if (!j.stationId || j.state === 'completed') continue
      const a = activityByStation.get(j.stationId) ?? { active: 0, waiting: 0, failed: 0 }
      if (j.state === 'active') a.active++
      else if (j.state === 'waiting') a.waiting++
      else if (j.state === 'failed') a.failed++
      activityByStation.set(j.stationId, a)
    }

    const stationsOut = stationList.map((s, i) => {
      const paused = stationPauseStates[i]
      return {
        id: s.id,
        slug: s.slug,
        name: s.name,
        paused,
        effectivePaused: globalPaused || paused,
        episodes: episodeCounts[i],
        activity: activityByStation.get(s.id) ?? { active: 0, waiting: 0, failed: 0 },
      }
    })

    const queues: Record<string, unknown> = {}
    for (const q of queueData) queues[q.name] = q.counts

    // Recent jobs feed (newest first), capped — the master activity panel.
    const recentJobs = allJobs
      .filter((j) => j.state !== 'waiting')
      .sort((a, b) => (b.finishedOn ?? b.processedOn ?? b.timestamp) - (a.finishedOn ?? a.processedOn ?? a.timestamp))
      .slice(0, 60)
    const waitingJobs = allJobs.filter((j) => j.state === 'waiting').slice(0, 40)

    return NextResponse.json({
      global: { paused: globalPaused, mode },
      queues,
      stations: stationsOut,
      jobs: { recent: recentJobs, waiting: waitingJobs },
      quarter: { start, end },
    })
  } catch (err) {
    console.error('GET /api/admin/overview failed:', err)
    return NextResponse.json({ error: 'Failed to load master overview' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const guard = await requireSuperAdmin(request)
    if (guard.error) return guard.error

    const body = await request.json()
    const { action } = body as { action?: string }

    // -- Global master pause (every station) --
    if (action === 'pause_all' || action === 'resume_all') {
      const paused = action === 'pause_all'
      const { error } = await supabaseAdmin
        .from('qir_settings')
        .upsert({ key: 'pipeline_paused', value: JSON.stringify(paused), updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) throw error
      invalidateSetting('pipeline_paused')
      return NextResponse.json({ ok: true, message: paused ? 'All stations paused' : 'All stations resumed', paused })
    }

    // Resolve and validate the target station for the per-station actions below.
    const resolveStation = async (): Promise<{ id: string; slug: string } | null> => {
      const stationId = body.stationId as string | undefined
      if (!stationId) return null
      const { data } = await supabaseAdmin.from('stations').select('id, slug').eq('id', stationId).maybeSingle()
      return data ?? null
    }

    // -- Per-station pause / resume --
    if (action === 'pause_station' || action === 'resume_station') {
      const station = await resolveStation()
      if (!station) return NextResponse.json({ error: 'Unknown or missing stationId' }, { status: 400 })
      const paused = action === 'pause_station'
      const { error } = await supabaseAdmin
        .from('station_settings')
        .upsert(
          { station_id: station.id, key: 'pipeline_paused', value: JSON.stringify(paused), updated_at: new Date().toISOString() },
          { onConflict: 'station_id,key' }
        )
      if (error) throw error
      invalidateSetting('pipeline_paused')
      return NextResponse.json({ ok: true, message: `${station.slug} ${paused ? 'paused' : 'resumed'}`, paused })
    }

    // -- Run now: advance a specific station's pipeline (mirrors /api/jobs advance) --
    if (action === 'advance') {
      const station = await resolveStation()
      if (!station) return NextResponse.json({ error: 'Unknown or missing stationId' }, { status: 400 })
      const { start, end } = currentQuarterBounds()
      const base = (status: string) =>
        supabaseAdmin
          .from('episode_log')
          .select('id', { count: 'exact', head: true })
          .eq('station_id', station.id)
          .gte('air_date', start)
          .lte('air_date', end)
          .eq('status', status)
      const [pending, transcribed, summarized] = await Promise.all([base('pending'), base('transcribed'), base('summarized')])

      const triggered: string[] = []
      await ingestQueue.add('master-ingest', { stationId: station.id })
      triggered.push('ingest')
      if ((pending.count ?? 0) > 0) {
        await transcribeQueue.add('master-transcribe', { stationId: station.id })
        triggered.push(`transcribe (${pending.count})`)
      }
      if ((transcribed.count ?? 0) > 0) {
        await summarizeQueue.add('master-summarize', { stationId: station.id })
        triggered.push(`summarize (${transcribed.count})`)
      }
      if ((summarized.count ?? 0) > 0) {
        await complianceQueue.add('master-compliance', { stationId: station.id })
        triggered.push(`compliance (${summarized.count})`)
      }
      return NextResponse.json({ ok: true, message: `${station.slug}: ${triggered.join(', ')}`, triggered })
    }

    // -- Retry / clear failed jobs, optionally scoped to one station --
    if (action === 'retry_failed' || action === 'clear_failed') {
      const queue = QUEUES[body.queue as QueueName]
      if (!queue) return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
      const stationId = body.stationId as string | undefined
      const failed = await queue.getFailed(0, 1000)
      const scoped = stationId ? failed.filter((j: any) => j.data?.stationId === stationId) : failed

      let count = 0
      for (const job of scoped) {
        try {
          if (action === 'retry_failed') await job.retry()
          else await job.remove()
          count++
        } catch {
          // Job may have been removed or already retried — skip.
        }
      }
      const verb = action === 'retry_failed' ? 'Retried' : 'Cleared'
      const scope = stationId ? ' for station' : ''
      return NextResponse.json({ ok: true, message: `${verb} ${count} failed ${body.queue} job(s)${scope}` })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('POST /api/admin/overview failed:', err)
    return NextResponse.json({ error: 'Failed to run master action' }, { status: 500 })
  }
}
