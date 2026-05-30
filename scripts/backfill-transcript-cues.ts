// One-time, re-runnable backfill of transcript_cues for the existing corpus
// (Phase 1 of ideas/TRANSCRIPT_SEARCH_SPEC.md). New episodes get their cues in
// the transcribe worker; this catches everything transcribed before migration
// 022 shipped.
//
// Usage:
//   tsx scripts/backfill-transcript-cues.ts          # only episodes missing cues
//   tsx scripts/backfill-transcript-cues.ts --force  # rebuild cues for all
//
// Uses the service-role client (RLS bypassed) — this is an operator task that
// spans every station. transcript_cues has no station_id; scope is inherited via
// episode_id, so no per-station fan-out is needed here.

import { supabaseAdmin } from '../lib/supabase'
import { parseVtt } from '../lib/vtt'

const FORCE = process.argv.includes('--force')
const PAGE = 200

async function hasCues(episodeId: number): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('transcript_cues')
    .select('id', { count: 'exact', head: true })
    .eq('episode_id', episodeId)
  return (count ?? 0) > 0
}

async function writeCues(episodeId: number, vtt: string): Promise<number> {
  const cues = parseVtt(vtt)
  await supabaseAdmin.from('transcript_cues').delete().eq('episode_id', episodeId)
  if (!cues.length) return 0
  const rows = cues.map((c) => ({
    episode_id: episodeId,
    cue_idx: c.index,
    start_ms: c.startMs,
    end_ms: c.endMs,
    text: c.text,
  }))
  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await supabaseAdmin.from('transcript_cues').insert(rows.slice(k, k + 500))
    if (error) throw new Error(error.message)
  }
  return rows.length
}

async function main() {
  console.log(`[backfill-cues] starting${FORCE ? ' (--force: rebuilding all)' : ''}`)
  let from = 0
  let episodes = 0
  let cuesWritten = 0
  let skipped = 0

  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('episode_id, vtt')
      .order('episode_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to page transcripts: ${error.message}`)
    if (!data?.length) break

    for (const row of data) {
      if (!row.vtt) {
        skipped++
        continue
      }
      if (!FORCE && (await hasCues(row.episode_id))) {
        skipped++
        continue
      }
      const n = await writeCues(row.episode_id, row.vtt)
      episodes++
      cuesWritten += n
    }

    console.log(`[backfill-cues] processed ${from + data.length} transcripts...`)
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`[backfill-cues] done — ${episodes} episodes, ${cuesWritten} cues written, ${skipped} skipped`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill-cues] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
