// One-time, re-runnable backfill of transcript_chunks (embeddings) for the
// existing corpus (Phase 2 of ideas/TRANSCRIPT_SEARCH_SPEC.md §6.2). New episodes
// get embedded in the summarize worker; this catches everything summarized before
// migration 023 shipped.
//
// Usage:
//   tsx scripts/backfill-transcript-embeddings.ts          # only episodes missing chunks
//   tsx scripts/backfill-transcript-embeddings.ts --force  # re-embed all
//
// Requires OPENAI_API_KEY. Uses the service-role client (RLS bypassed) — an
// operator task spanning every station. transcript_chunks has no station_id;
// scope is inherited via episode_id. We join episode_log to log the (real) embed
// cost per station in usage_log.

import { supabaseAdmin } from '../lib/supabase'
import { getEmbeddingModel } from '../lib/settings'
import { buildEpisodeChunkRows, storeEpisodeChunks } from '../lib/transcript-embeddings'
import { logEmbeddingUsage } from '../lib/usage'

const FORCE = process.argv.includes('--force')
const PAGE = 100

async function hasChunks(episodeId: number): Promise<boolean> {
  const { count } = await supabaseAdmin
    .from('transcript_chunks')
    .select('id', { count: 'exact', head: true })
    .eq('episode_id', episodeId)
  return (count ?? 0) > 0
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[backfill-embeddings] OPENAI_API_KEY is required')
    process.exit(1)
  }
  console.log(`[backfill-embeddings] starting${FORCE ? ' (--force: re-embedding all)' : ''}`)

  // Cache the per-station embedding model so each episode doesn't re-resolve it.
  const modelByStation = new Map<string, string>()
  async function modelFor(stationId: string): Promise<string> {
    let m = modelByStation.get(stationId)
    if (!m) {
      m = await getEmbeddingModel(stationId)
      modelByStation.set(stationId, m)
    }
    return m
  }

  let from = 0
  let episodes = 0
  let chunksWritten = 0
  let tokens = 0
  let skipped = 0

  for (;;) {
    // Join episode_log so we have station_id for usage logging.
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('episode_id, vtt, episode_log!inner(station_id)')
      .order('episode_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to page transcripts: ${error.message}`)
    if (!data?.length) break

    for (const row of data as Array<{ episode_id: number; vtt: string | null; episode_log: { station_id: string } | { station_id: string }[] }>) {
      if (!row.vtt) {
        skipped++
        continue
      }
      if (!FORCE && (await hasChunks(row.episode_id))) {
        skipped++
        continue
      }
      // PostgREST returns the embedded relation as an object (or array under some
      // configs) — normalize to the station_id either way.
      const rel = Array.isArray(row.episode_log) ? row.episode_log[0] : row.episode_log
      const stationId = rel?.station_id
      const model = stationId ? await modelFor(stationId) : undefined

      const { rows, tokens: t } = await buildEpisodeChunkRows(row.vtt, model)
      await storeEpisodeChunks(supabaseAdmin, row.episode_id, rows)
      if (t > 0 && stationId) await logEmbeddingUsage(stationId, row.episode_id, t, model)

      episodes++
      chunksWritten += rows.length
      tokens += t
    }

    console.log(`[backfill-embeddings] processed ${from + data.length} transcripts...`)
    if (data.length < PAGE) break
    from += PAGE
  }

  console.log(`[backfill-embeddings] done — ${episodes} episodes, ${chunksWritten} chunks, ${tokens} tokens, ${skipped} skipped`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill-embeddings] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
