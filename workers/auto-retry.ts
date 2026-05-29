import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'

const MAX_RETRY_COUNT = 3
// How long an episode may sit in a transient processing status before it's
// considered orphaned (worker crashed mid-batch) and reset to the prior stage.
// Generous because a whole batch is claimed at once, so the last episode in a
// slow batch can legitimately wait here a while; startup recovery (recoverAll)
// handles the common crash case immediately, so this is just a safety net.
const STUCK_MINUTES = 60

export async function processAutoRetry(job: Job) {
  console.log('[auto-retry] checking failed episodes...')

  // Recover episodes orphaned in a transient status by a crashed worker.
  // On startup (recoverAll) reset them immediately — no worker is running yet,
  // so any such row is definitely orphaned. Periodically, only reset stale rows
  // so we never steal episodes a live worker is actively processing.
  const recoverAll = job.data?.recoverAll === true
  const staleCutoff = new Date(Date.now() - STUCK_MINUTES * 60_000).toISOString()
  let recovered = 0
  for (const [stuckStatus, resetTo] of [
    ['transcribing', 'pending'],
    ['summarizing', 'transcribed'],
  ] as const) {
    let q = supabaseAdmin.from('episode_log').select('id').eq('status', stuckStatus)
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
        .in('id', stuck.map((e) => e.id))
      recovered += stuck.length
      console.log(`[auto-retry] recovered ${stuck.length} stuck '${stuckStatus}' → ${resetTo}`)
    }
  }

  // Promote episodes that have exceeded max retries to 'dead' status
  const { data: deadEpisodes, error: deadError } = await supabaseAdmin
    .from('episode_log')
    .select('id')
    .eq('status', 'failed')
    .gte('retry_count', MAX_RETRY_COUNT)

  if (deadError) {
    console.error('[auto-retry] failed to query dead episodes:', deadError.message)
  } else if (deadEpisodes?.length) {
    const deadIds = deadEpisodes.map((ep) => ep.id)
    await supabaseAdmin
      .from('episode_log')
      .update({ status: 'dead', updated_at: new Date().toISOString() })
      .in('id', deadIds)
    console.log(`[auto-retry] moved ${deadIds.length} episodes to dead status`)
  }

  // Reset retryable failed episodes back to pending (retry_count < max)
  const { data: retryable, error: retryError } = await supabaseAdmin
    .from('episode_log')
    .select('id, retry_count')
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
    .in('id', retryIds)

  console.log(`[auto-retry] reset ${retryIds.length} episodes to pending`)
  return { retried: retryIds.length, dead: deadEpisodes?.length ?? 0, recovered }
}
