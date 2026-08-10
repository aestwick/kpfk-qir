import type { Queue } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { jobPriority } from '../lib/tier'

// Only resurrect backfills touched recently — bounds the scan and avoids
// resuming a quarter the operator abandoned long ago.
const RECENCY_DAYS = 14

/** Current calendar quarter [start, end] as YYYY-MM-DD (mirrors workers/transcribe.ts). */
function currentQuarterBounds(): { start: string; end: string } {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const m0 = q * 3
  const start = new Date(now.getFullYear(), m0, 1).toISOString().split('T')[0]
  const end = new Date(now.getFullYear(), m0 + 3, 0).toISOString().split('T')[0]
  return { start, end }
}

/** The calendar quarter that a given air_date falls in, as a [start, end] window + label. */
function quarterBoundsForDate(dateStr: string): { start: string; end: string; label: string } {
  const d = new Date(dateStr + 'T00:00:00Z')
  const year = d.getUTCFullYear()
  const q = Math.floor(d.getUTCMonth() / 3)
  const m0 = q * 3
  const start = new Date(Date.UTC(year, m0, 1)).toISOString().split('T')[0]
  const end = new Date(Date.UTC(year, m0 + 3, 0)).toISOString().split('T')[0]
  return { start, end, label: `${year}-Q${q + 1}` }
}

/**
 * Self-healing backfill resume, run on worker startup.
 *
 * A windowed historical backfill drains via a BullMQ continue/backoff chain that
 * lives ONLY in Redis. A worker restart drops the in-flight chain, and nothing
 * else re-enqueues an off-current-quarter window (the hourly cron is current-quarter
 * only), so the drain silently stalls until a human re-kicks it. This closes that
 * gap: scan for backfill episodes still mid-drain — status pending/transcribed,
 * air_date OUTSIDE the current quarter, created within the last {@link RECENCY_DAYS}
 * days — and re-kick a windowed transcribe + summarize chain per (station, quarter).
 *
 * Safety / idempotency:
 *  - The per-(station, stage) lock + atomic status claim prevent double-processing,
 *    so overlapping with a chain that's already alive is harmless.
 *  - An already-drained or excluded-only window is a clean no-op (remaining:false).
 *  - Live current-quarter work is never touched (the air_date filter excludes it).
 *  - Windowed jobs bypass the per-station park (operator action) but still honor the
 *    GLOBAL kill switch via the processors.
 */
export async function resumeWindowedBackfills(
  transcribeQueue: Queue,
  summarizeQueue: Queue,
): Promise<void> {
  const { start: curStart, end: curEnd } = currentQuarterBounds()
  const since = new Date(Date.now() - RECENCY_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('episode_log')
    .select('station_id, air_date')
    .in('status', ['pending', 'transcribed'])
    .not('air_date', 'is', null)
    .gte('created_at', since)
    .or(`air_date.lt.${curStart},air_date.gt.${curEnd}`)

  if (error) {
    console.error('[resume] backfill scan failed:', error.message)
    return
  }
  if (!data?.length) {
    console.log('[resume] no mid-drain backfills to resume')
    return
  }

  // Collapse to one window per (station, quarter).
  const windows = new Map<string, { stationId: string; start: string; end: string; label: string }>()
  for (const row of data) {
    if (!row.station_id || !row.air_date) continue
    const q = quarterBoundsForDate(row.air_date as string)
    const mapKey = `${row.station_id}:${q.label}`
    if (!windows.has(mapKey)) {
      windows.set(mapKey, { stationId: row.station_id as string, start: q.start, end: q.end, label: q.label })
    }
  }

  for (const w of Array.from(windows.values())) {
    const priority = await jobPriority(w.stationId)
    const window = { window: { start: w.start, end: w.end } }
    // transcribe chain drains pending → summarize → compliance; the summarize chain
    // catches any orphaned 'transcribed' left behind when the chain died mid-cascade.
    await transcribeQueue.add(
      'backfill-resume-transcribe',
      { stationId: w.stationId, source: 'chain', chain: true, ...window },
      { priority },
    )
    await summarizeQueue.add(
      'backfill-resume-summarize',
      { stationId: w.stationId, source: 'chain', chain: true, ...window },
      { priority },
    )
    console.log(`[resume] re-kicked backfill ${w.label} for station ${w.stationId} (${w.start}..${w.end})`)
  }
  console.log(`[resume] resumed ${windows.size} backfill window(s)`)
}
