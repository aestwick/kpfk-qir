import { supabaseAdmin } from '../lib/supabase'
import { getCurrentQuarterBounds } from '../lib/quarters'

/**
 * Shared candidate-select + atomic-claim for the transcribe and summarize stage
 * workers, which had identical copies of this block (differing only in the
 * status strings and log prefix).
 *
 * Both pull a batch of current-quarter episodes in `fromStatus`, drop
 * excluded-category rows (so they stay put rather than getting stuck mid-stage),
 * then atomically flip the rest to `toStatus`. The `.eq('status', fromStatus)`
 * guard on the update is what stops overlapping runs (manual retry,
 * continue-chain, BullMQ attempts, cron) from grabbing the same episode. Returns
 * the claimed rows (empty when nothing is available or claimable); the
 * per-episode work stays in each worker.
 *
 * Runs on the service-role client (RLS bypassed), so the explicit
 * `.eq('station_id', stationId)` on both the select and the claim is the only
 * tenant guard — kept here in one place for both workers.
 *
 * Compliance deliberately does NOT use this: it has no intermediate claim status
 * and a different candidate query (optional per-show re-run), so it stays as-is.
 */
export async function claimEpisodeBatch(opts: {
  stationId: string
  fromStatus: string
  toStatus: string
  batchSize: number
  excludedCategories: string[]
  /** Log prefix, e.g. 'transcribe' / 'summarize'. */
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any[]> {
  const { stationId, fromStatus, toStatus, batchSize, excludedCategories, label } = opts
  const { start, end } = getCurrentQuarterBounds()

  // Candidate episodes in fromStatus from the current quarter (including those
  // with null air_date created this quarter — older ingests didn't populate it).
  const { data: candidates, error } = await supabaseAdmin
    .from('episode_log')
    .select('id, category')
    .eq('station_id', stationId)
    .eq('status', fromStatus)
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!candidates?.length) {
    console.log(`[${label}] no ${fromStatus} episodes`)
    return []
  }

  // Drop excluded categories before claiming so they stay in fromStatus.
  const claimIds = candidates
    .filter((ep) => !excludedCategories.some((exc) => ep.category?.includes(exc)))
    .map((ep) => ep.id)

  if (!claimIds.length) {
    console.log(`[${label}] only excluded-category episodes ${fromStatus}`)
    return []
  }

  // Atomically claim: only rows still in fromStatus are flipped to toStatus.
  const { data: episodes, error: claimError } = await supabaseAdmin
    .from('episode_log')
    .update({ status: toStatus, updated_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .in('id', claimIds)
    .eq('status', fromStatus)
    .select('*')

  if (claimError) throw new Error(`Failed to claim episodes: ${claimError.message}`)
  if (!episodes?.length) {
    console.log(`[${label}] no episodes claimed (already taken by another run)`)
    return []
  }

  return episodes
}

/**
 * Count episodes still in `status` for this station in the current quarter — the
 * signal the transcribe/summarize workers use after a batch to decide whether to
 * re-queue a continuation. Same quarter window as claimEpisodeBatch, and was
 * likewise duplicated across both workers.
 */
export async function countRemainingInStatus(stationId: string, status: string): Promise<number> {
  const { start, end } = getCurrentQuarterBounds()
  const { count } = await supabaseAdmin
    .from('episode_log')
    .select('id', { count: 'exact', head: true })
    .eq('station_id', stationId)
    .eq('status', status)
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
  return count ?? 0
}
