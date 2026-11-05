// Server helpers shared by the /api/corrections routes (rules, names,
// suggestions). Kept out of the route files so all three validate scope and
// queue the stored-transcript backfill the same way.

import type { SupabaseClient } from '@supabase/supabase-js'
import { correctionsQueue } from './queue'

/** Queue a re-apply of pending rules to this station's stored transcripts.
 *  Fire-and-forget: the nightly run picks up anything a failed enqueue missed. */
export function queueCorrectionsBackfill(stationId: string): void {
  correctionsQueue
    .add('corrections-backfill', { stationId, task: 'backfill' }, { delay: 5_000 })
    .catch((err) => console.warn('[corrections] could not queue backfill:', err instanceof Error ? err.message : err))
}

/** A show scope must be one of this station's show keys (null = station-wide). */
export async function validShowKey(
  client: SupabaseClient,
  stationId: string,
  showKey: unknown,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  if (showKey == null || showKey === '') return { ok: true, value: null }
  if (typeof showKey !== 'string') return { ok: false, error: 'show_key must be a string' }
  const { data, error } = await client
    .from('show_keys')
    .select('key')
    .eq('station_id', stationId)
    .eq('key', showKey)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: `Unknown show: ${showKey}` }
  return { ok: true, value: showKey }
}
