import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { listStationIds } from '../lib/stations'
import { autoRetryQueue, transcribeQueue, summarizeQueue } from '../lib/queue'
import { isPipelinePaused } from '../lib/settings'
import { getProcessingWindowBounds } from '../lib/quarters'
import { jobPriority } from '../lib/tier'

const MAX_RETRY_COUNT = 3
// How long an episode may sit in a transient processing status before it's
// considered orphaned (worker crashed mid-batch) and reset to the prior stage.
// Generous because a whole batch is claimed at once, so the last episode in a
// slow batch can legitimately wait here a while; startup recovery (recoverAll)
// handles the common crash case immediately, so this is just a safety net.
const STUCK_MINUTES = 60

async function recoverAndRetry(job: Job) {
  const stationId = job.data?.stationId as string | undefined
  const recoverAll = job.data?.recoverAll === true

  // Cron/startup tick (no stationId): fan out one auto-retry job per station,
  // preserving the recoverAll flag.
  if (!stationId) {
    const ids = await listStationIds()
    for (const id of ids) {
      await autoRetryQueue.add('auto-retry-station', { stationId: id, recoverAll })
    }
    console.log(`[auto-retry] dispatched auto-retry for ${ids.length} station(s)`)
    return { dispatched: ids.length }
  }

  console.log(`[auto-retry] checking failed episodes for station ${stationId}...`)

  // Recover episodes orphaned in a transient status by a crashed worker.
  // On startup (recoverAll) reset them immediately — no worker is running yet,
  // so any such row is definitely orphaned. Periodically, only reset stale rows
  // so we never steal episodes a live worker is actively processing.
  // Service-role bypasses RLS, so the station_id filter is the only guard.
  const staleCutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString()
  let recovered = 0
  for (const [stuckStatus, resetTo] of [
    ['transcribing', 'pending'],
    ['summarizing', 'transcribed'],
  ] as const) {
    let q = supabaseAdmin.from('episode_log').select('id').eq('station_id', stationId).eq('status', stuckStatus)
    if (!recoverAll) q = q.lt('updated_at', staleCutoff)
    const { data: stuck, error: stuckErr } = await q
    if (stuckErr) {
      console.error(`[auto-retry] failed to query stuck '${stuckStatus}':`, stuckErr.message)
      continue
    }
    if (stuck?.length) {
      await supabaseAdmin
        .from('episode_log')
        .update({ status: resetTo, updated_at: new Date().toISOString() })
        .eq('station_id', stationId)
        .in('id', stuck.map((e) => e.id))
      recovered += stuck.length
      console.log(`[auto-retry] recovered ${stuck.length} stuck '${stuckStatus}' → ${resetTo}`)
    }
  }

  // Promote episodes that have exceeded max retries to 'dead' status
  const { data: deadEpisodes, error: deadError } = await supabaseAdmin
    .from('episode_log')
    .select('id')
    .eq('station_id', stationId)
    .eq('status', 'failed')
    .gte('retry_count', MAX_RETRY_COUNT)

  if (deadError) {
    console.error('[auto-retry] failed to query dead episodes:', deadError.message)
  } else if (deadEpisodes?.length) {
    const deadIds = deadEpisodes.map((ep) => ep.id)
    await supabaseAdmin
      .from('episode_log')
      .update({ status: 'dead', updated_at: new Date().toISOString() })
      .eq('station_id', stationId)
      .in('id', deadIds)
    console.log(`[auto-retry] moved ${deadIds.length} episodes to dead status`)
  }

  // Reset retryable failed episodes back to pending (retry_count < max)
  const { data: retryable, error: retryError } = await supabaseAdmin
    .from('episode_log')
    .select('id, retry_count')
    .eq('station_id', stationId)
    .eq('status', 'failed')
    .lt('retry_count', MAX_RETRY_COUNT)

  if (retryError) {
    console.error('[auto-retry] failed to query retryable episodes:', retryError.message)
    return { retried: 0, dead: deadEpisodes?.length ?? 0 }
  }

  if (!retryable?.length) {
    console.log('[auto-retry] no retryable episodes')
    return { retried: 0, dead: deadEpisodes?.length ?? 0, recovered }
  }

  const retryIds = retryable.map((ep) => ep.id)
  await supabaseAdmin
    .from('episode_log')
    .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .in('id', retryIds)

  console.log(`[auto-retry] reset ${retryIds.length} episodes to pending`)
  return { retried: retryIds.length, dead: deadEpisodes?.length ?? 0, recovered }
}

export async function processAutoRetry(job: Job) {
  const result = await recoverAndRetry(job)
  const stationId = job.data?.stationId as string | undefined
  if (stationId) await kickWaitingWork(stationId)
  return result
}

/**
 * Start the chain for work that is already waiting. Transcription otherwise only
 * starts when ingest finds a NEW episode, so after a restart (2026-11-21: 74
 * pending sat idle after `docker restart qir-worker`) or after this job resets
 * failed episodes to pending, nothing ran until the next new airing. Runs at
 * startup (after orphan recovery) and on the 4-hourly tick. Cheap when idle:
 * two head counts. Stage locks make a kick that overlaps a running chain a no-op.
 */
async function kickWaitingWork(stationId: string) {
  try {
    if (await isPipelinePaused(stationId)) return
    const { start, end } = getProcessingWindowBounds()
    const inWindow = `priority.is.true,and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`
    const count = async (status: string) => {
      const { count: n } = await supabaseAdmin
        .from('episode_log')
        .select('id', { count: 'exact', head: true })
        .eq('station_id', stationId)
        .eq('status', status)
        .or(inWindow)
      return n ?? 0
    }
    const [pending, transcribed] = await Promise.all([count('pending'), count('transcribed')])
    const priority = await jobPriority(stationId)
    // source 'chain' + chain: true → transcribe hands off to summarize → compliance.
    if (pending > 0) {
      await transcribeQueue.add('auto-retry-kick', { stationId, source: 'chain', chain: true }, { priority })
    }
    if (transcribed > 0) {
      await summarizeQueue.add('auto-retry-kick', { stationId, source: 'chain', chain: true }, { priority })
    }
    if (pending || transcribed) {
      console.log(`[auto-retry] kicked waiting work for station ${stationId}: ${pending} pending, ${transcribed} transcribed`)
    }
  } catch (err) {
    console.error(`[auto-retry] kick failed for station ${stationId}:`, err instanceof Error ? err.message : err)
  }
}
