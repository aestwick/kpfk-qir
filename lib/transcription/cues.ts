// Replace an episode's timed search cues (transcript_cues) from its VTT.
// Shared by the transcribe worker (new transcripts), the corrections worker
// (rules re-applied to stored transcripts) and scripts/backfill-transcript-cues.ts.
// Idempotent per episode: clear then re-insert, so re-runs never duplicate.

import type { SupabaseClient } from '@supabase/supabase-js'
import { parseVtt } from '../vtt'

export async function replaceEpisodeCues(
  client: SupabaseClient,
  episodeId: number,
  vtt: string | null | undefined,
): Promise<number> {
  const cues = parseVtt(vtt)
  const { error: delError } = await client.from('transcript_cues').delete().eq('episode_id', episodeId)
  if (delError) throw new Error(delError.message)
  if (!cues.length) return 0
  const rows = cues.map((c) => ({
    episode_id: episodeId,
    cue_idx: c.index,
    start_ms: c.startMs,
    end_ms: c.endMs,
    text: c.text,
  }))
  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await client.from('transcript_cues').insert(rows.slice(k, k + 500))
    if (error) throw new Error(error.message)
  }
  return rows.length
}
