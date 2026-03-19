import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'

const MAX_RETRY_COUNT = 3

export async function processAutoRetry(job: Job) {
  console.log('[auto-retry] checking failed episodes...')

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
    return { retried: 0, dead: deadEpisodes?.length ?? 0 }
  }

  const retryIds = retryable.map((ep) => ep.id)
  await supabaseAdmin
    .from('episode_log')
    .update({ status: 'pending', error_message: null, updated_at: new Date().toISOString() })
    .in('id', retryIds)

  console.log(`[auto-retry] reset ${retryIds.length} episodes to pending`)
  return { retried: retryIds.length, dead: deadEpisodes?.length ?? 0 }
}
