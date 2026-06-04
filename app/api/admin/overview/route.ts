import { NextRequest, NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse, StationContext } from '@/lib/auth'
import { getSetting, invalidateSetting, invalidateBudgetCache, isStationPaused, isStationOverBudget, isPipelinePaused } from '@/lib/settings'
import { getCurrentQuarterBounds } from '@/lib/quarters'

export const dynamic = 'force-dynamic'

// Super-admin master control: a cross-tenant view of every station's pipeline,
// with per-station pause/resume, run-now, and failed-job retry/clear. This is the
// one place that intentionally reaches across stations, so it hard-gates on
// isSuperAdmin (RLS would otherwise scope reads to memberships) and uses the
// service-role client for the cross-tenant aggregation.

const QUEUES = { ingest: ingestQueue, transcribe: transcribeQueue, summarize: summarizeQueue, compliance: complianceQueue }
type QueueName = keyof typeof QUEUES
const EPISODE_STATUSES = ['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed'] as const

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

    const { start, end } = getCurrentQuarterBounds()
    // Month-to-date bound for the running spend tally (month ⊆ quarter, so the
    // single quarter-scoped usage pull below covers it).
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)

    // All stations (service-role; this is an admin cross-tenant view).
    const { data: stations, error: stationsErr } = await supabaseAdmin
      .from('stations')
      .select('id, slug, name, tier')
      .order('name')
    if (stationsErr) throw stationsErr
    const stationList = stations ?? []

    const queueNames = Object.keys(QUEUES) as QueueName[]

    const [globalPaused, mode, stationPauseStates, episodeCounts, queueData, usageRows] = await Promise.all([
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
          const [pending, transcribed, summarized, checked, failed, total, lastAdv] = await Promise.all([
            base().eq('status', 'pending'),
            base().eq('status', 'transcribed'),
            base().eq('status', 'summarized'),
            base().eq('status', 'compliance_checked'),
            base().eq('status', 'failed'),
            base(),
            // Most recent stage advance (any quarter) — the staleness signal for
            // the glance view's "last advanced" clock and the KPFK-dark check.
            supabaseAdmin
              .from('episode_log')
              .select('updated_at')
              .eq('station_id', s.id)
              .in('status', ['transcribed', 'summarized', 'compliance_checked'])
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
          ])
          return {
            counts: {
              pending: pending.count ?? 0,
              transcribed: transcribed.count ?? 0,
              summarized: summarized.count ?? 0,
              compliance_checked: checked.count ?? 0,
              failed: failed.count ?? 0,
              total: total.count ?? 0,
            },
            lastAdvancedAt: (lastAdv.data?.updated_at as string | undefined) ?? null,
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
      // Running spend tally: every station's usage this quarter (month-to-date is
      // a subset). Service-role cross-tenant read, aggregated per station below.
      supabaseAdmin
        .from('usage_log')
        .select('station_id, service, estimated_cost, created_at')
        .gte('created_at', start),
    ])

    // Per-station spend: quarter-to-date (groq/openai/total) + month-to-date total.
    type StationCost = { groq: number; openai: number; total: number; month: number }
    const costByStation = new Map<string, StationCost>()
    // Combined all-stations totals for the universal ceiling (every row, matching
    // lib/settings#getTotalSpend — independent of per-station attribution).
    const grand = { month: 0, quarter: 0 }
    for (const row of usageRows.data ?? []) {
      const amount = Number(row.estimated_cost) || 0
      const inMonth = typeof row.created_at === 'string' && row.created_at.slice(0, 10) >= monthStart
      grand.quarter += amount
      if (inMonth) grand.month += amount
      if (!row.station_id) continue
      const c = costByStation.get(row.station_id) ?? { groq: 0, openai: 0, total: 0, month: 0 }
      c.total += amount
      if (row.service === 'groq') c.groq += amount
      else if (row.service === 'openai') c.openai += amount
      if (inMonth) c.month += amount
      costByStation.set(row.station_id, c)
    }

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

    // Spend caps (super-admin-managed): global defaults + per-station overrides.
    // A positive number is a cap; anything else (missing / ≤ 0) means "no cap".
    const num = (v: unknown): number | null => {
      let parsed: unknown = v
      if (typeof v === 'string') { try { parsed = JSON.parse(v) } catch { parsed = v } }
      const n = Number(parsed)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const [globalMonthly, globalQuarterly, universalMonthly, universalQuarterly, overrideRowsRes] = await Promise.all([
      getSetting<number>('spend_limit_monthly'),
      getSetting<number>('spend_limit_quarterly'),
      getSetting<number>('spend_limit_universal_monthly'),
      getSetting<number>('spend_limit_universal_quarterly'),
      supabaseAdmin
        .from('station_settings')
        .select('station_id, key, value')
        .in('key', ['spend_limit_monthly', 'spend_limit_quarterly']),
    ])
    const budgetDefaults = { monthly: num(globalMonthly), quarterly: num(globalQuarterly) }
    const budgetUniversalCaps = { monthly: num(universalMonthly), quarterly: num(universalQuarterly) }
    const overrideByStation = new Map<string, { monthly: number | null; quarterly: number | null }>()
    for (const row of overrideRowsRes.data ?? []) {
      const entry = overrideByStation.get(row.station_id) ?? { monthly: null, quarterly: null }
      if (row.key === 'spend_limit_monthly') entry.monthly = num(row.value)
      else if (row.key === 'spend_limit_quarterly') entry.quarterly = num(row.value)
      overrideByStation.set(row.station_id, entry)
    }

    // Universal (all-stations combined) ceiling: trips every station at once.
    const universalOverMonthly = budgetUniversalCaps.monthly != null && grand.month >= budgetUniversalCaps.monthly
    const universalOverQuarterly = budgetUniversalCaps.quarterly != null && grand.quarter >= budgetUniversalCaps.quarterly
    const universalOverBudget = universalOverMonthly || universalOverQuarterly

    // Tier order = sharing order: production first, then paying, demo, test.
    const TIER_RANK: Record<string, number> = { production: 0, paying: 1, demo: 2, test: 3 }
    const stationsOut = stationList
      .map((s, i) => {
        const paused = stationPauseStates[i]
        const spend = costByStation.get(s.id) ?? { groq: 0, openai: 0, total: 0, month: 0 }
        const ov = overrideByStation.get(s.id) ?? { monthly: null, quarterly: null }
        const effMonthly = ov.monthly ?? budgetDefaults.monthly
        const effQuarterly = ov.quarterly ?? budgetDefaults.quarterly
        const overMonthly = effMonthly != null && spend.month >= effMonthly
        const overQuarterly = effQuarterly != null && spend.total >= effQuarterly
        const overBudget = overMonthly || overQuarterly
        return {
          id: s.id,
          slug: s.slug,
          name: s.name,
          tier: (s.tier as string | null) ?? 'test',
          paused,
          // Over-budget auto-pause folds into effective pause (mirrors the worker
          // gate): the station's own cap OR the universal ceiling. The reason is
          // only exposed on this super-admin view.
          effectivePaused: globalPaused || paused || overBudget || universalOverBudget,
          episodes: episodeCounts[i].counts,
          lastAdvancedAt: episodeCounts[i].lastAdvancedAt,
          activity: activityByStation.get(s.id) ?? { active: 0, waiting: 0, failed: 0 },
          cost: spend,
          budget: {
            monthly: effMonthly,
            quarterly: effQuarterly,
            // Explicit per-station override (null = inheriting the global default).
            override: { monthly: ov.monthly, quarterly: ov.quarterly },
            overMonthly,
            overQuarterly,
            overBudget,
          },
        }
      })
      .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.name.localeCompare(b.name))

    const queues: Record<string, unknown> = {}
    for (const q of queueData) queues[q.name] = q.counts

    // Recent jobs feed (newest first), capped — the master activity panel.
    const recentJobs = allJobs
      .filter((j) => j.state !== 'waiting')
      .sort((a, b) => (b.finishedOn ?? b.processedOn ?? b.timestamp) - (a.finishedOn ?? a.processedOn ?? a.timestamp))
      .slice(0, 60)
    const waitingJobs = allJobs.filter((j) => j.state === 'waiting').slice(0, 40)

    // Grand totals across all stations for the running tally header.
    const costTotals = stationsOut.reduce(
      (acc, s) => {
        acc.quarter += s.cost.total
        acc.month += s.cost.month
        return acc
      },
      { quarter: 0, month: 0 }
    )

    return NextResponse.json({
      global: { paused: globalPaused, mode },
      queues,
      stations: stationsOut,
      jobs: { recent: recentJobs, waiting: waitingJobs },
      quarter: { start, end },
      costTotals,
      budgetDefaults,
      budgetUniversal: {
        monthly: budgetUniversalCaps.monthly,
        quarterly: budgetUniversalCaps.quarterly,
        overMonthly: universalOverMonthly,
        overQuarterly: universalOverQuarterly,
        overBudget: universalOverBudget,
      },
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

    // -- Set spend caps (super-admin only; this whole route is super-admin-gated) --
    // body: { action:'set_budget', scope?:'universal', stationId?, monthly?, quarterly? }
    //   scope:'universal' → combined all-stations ceiling (global-only keys);
    //   else stationId present → per-station override; absent → global default.
    //   A positive number sets a cap; null / 0 / '' clears it (delete the row).
    //   A period key omitted from the body is left untouched.
    if (action === 'set_budget') {
      const universal = body.scope === 'universal'
      // stationId only applies to per-station overrides; ignored for universal/global.
      const stationId = universal ? undefined : (body.stationId as string | undefined)
      const now = new Date().toISOString()
      const KEYS = universal
        ? { monthly: 'spend_limit_universal_monthly', quarterly: 'spend_limit_universal_quarterly' }
        : ({ monthly: 'spend_limit_monthly', quarterly: 'spend_limit_quarterly' } as const)

      if (stationId) {
        const { data: station } = await supabaseAdmin.from('stations').select('id, slug').eq('id', stationId).maybeSingle()
        if (!station) return NextResponse.json({ error: 'Unknown or missing stationId' }, { status: 400 })
      }

      for (const period of ['monthly', 'quarterly'] as const) {
        if (!(period in body)) continue
        const raw = body[period]
        const n = Number(raw)
        const cap = Number.isFinite(n) && n > 0 ? n : null // null = clear
        const key = KEYS[period]

        if (stationId) {
          if (cap == null) {
            const { error } = await supabaseAdmin.from('station_settings').delete().eq('station_id', stationId).eq('key', key)
            if (error) throw error
          } else {
            const { error } = await supabaseAdmin
              .from('station_settings')
              .upsert({ station_id: stationId, key, value: JSON.stringify(cap), updated_at: now }, { onConflict: 'station_id,key' })
            if (error) throw error
          }
        } else {
          if (cap == null) {
            const { error } = await supabaseAdmin.from('qir_settings').delete().eq('key', key)
            if (error) throw error
          } else {
            const { error } = await supabaseAdmin
              .from('qir_settings')
              .upsert({ key, value: JSON.stringify(cap), updated_at: now }, { onConflict: 'key' })
            if (error) throw error
          }
        }
        invalidateSetting(key)
      }
      // Spend caps changed — drop the cached over-budget decisions so enforcement
      // re-evaluates promptly (rather than lagging up to the 60s budget cache TTL).
      invalidateBudgetCache()
      const scopeMsg = universal ? 'Universal spend cap updated' : stationId ? 'Station spend cap updated' : 'Global spend cap updated'
      return NextResponse.json({ ok: true, message: scopeMsg })
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

      // Only report stages that will actually run. Under the GLOBAL pause every
      // worker (incl. ingest) is BullMQ-paused, so nothing would run — don't queue
      // it and say so. Under a per-station pause OR an over-budget auto-pause,
      // ingest still runs (liveness) but the expensive stages skip themselves
      // (each processor gates on isPipelinePaused(stationId)), so queue/report
      // ingest only — otherwise we'd report transcribe/summarize as "triggered"
      // when they're going to skip.
      const [globalPaused, stationPaused, overBudget] = await Promise.all([
        isPipelinePaused(),
        isStationPaused(station.id),
        isStationOverBudget(station.id),
      ])
      if (globalPaused) {
        return NextResponse.json({
          ok: true,
          message: `${station.slug}: pipeline is globally paused — resume before advancing`,
          triggered: [],
        })
      }

      const { start, end } = getCurrentQuarterBounds()
      const base = (status: string) =>
        supabaseAdmin
          .from('episode_log')
          .select('id', { count: 'exact', head: true })
          .eq('station_id', station.id)
          .gte('air_date', start)
          .lte('air_date', end)
          .eq('status', status)

      const triggered: string[] = []
      await ingestQueue.add('master-ingest', { stationId: station.id })
      triggered.push('ingest')

      if (stationPaused || overBudget) {
        const reason = stationPaused ? 'station is paused' : 'station is over its spend cap'
        const remedy = stationPaused ? 'resume to process' : 'raise/clear the cap or wait for the budget to roll over'
        return NextResponse.json({
          ok: true,
          message: `${station.slug}: ingest queued — ${reason}, so processing stages were skipped (${remedy})`,
          triggered,
        })
      }

      const [pending, transcribed, summarized] = await Promise.all([base('pending'), base('transcribed'), base('summarized')])
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
    // Sweeps ALL queues by default (failures land wherever a stage broke); pass
    // body.queue to narrow to one.
    if (action === 'retry_failed' || action === 'clear_failed') {
      const only = body.queue as QueueName | undefined
      if (only && !QUEUES[only]) return NextResponse.json({ error: 'Invalid queue name' }, { status: 400 })
      const targets: QueueName[] = only ? [only] : (Object.keys(QUEUES) as QueueName[])
      const stationId = body.stationId as string | undefined

      let count = 0
      for (const name of targets) {
        const failed = await QUEUES[name].getFailed(0, 1000)
        const scoped = stationId ? failed.filter((j: any) => j.data?.stationId === stationId) : failed
        for (const job of scoped) {
          try {
            if (action === 'retry_failed') await job.retry()
            else await job.remove()
            count++
          } catch {
            // Job may have been removed or already retried — skip.
          }
        }
      }
      const verb = action === 'retry_failed' ? 'Retried' : 'Cleared'
      const scope = stationId ? ' for station' : ''
      const where = only ? ` ${only}` : ''
      return NextResponse.json({ ok: true, message: `${verb} ${count} failed${where} job(s)${scope}` })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (err) {
    console.error('POST /api/admin/overview failed:', err)
    return NextResponse.json({ error: 'Failed to run master action' }, { status: 500 })
  }
}
