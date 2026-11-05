// One-time, re-runnable backfill of transcript_chunks (embeddings) for the
// existing corpus (Phase 2 of ideas/TRANSCRIPT_SEARCH_SPEC.md §6.2). New episodes
// get embedded in the summarize worker; this catches everything summarized before
// migration 023 shipped.
//
// Usage:
//   tsx scripts/backfill-transcript-embeddings.ts                 # only episodes missing chunks
//   tsx scripts/backfill-transcript-embeddings.ts --force         # re-embed all
//   tsx scripts/backfill-transcript-embeddings.ts --limit 20      # pilot: first N episodes
//   tsx scripts/backfill-transcript-embeddings.ts --concurrency 4 # parallel episodes (default 4)
//   tsx scripts/backfill-transcript-embeddings.ts --max-cost 2    # stop once est. spend ≥ $2 (default 3)
//
// Requires OPENAI_API_KEY. Uses the service-role client (RLS bypassed) — an
// operator task spanning every station. transcript_chunks has no station_id;
// scope is inherited via episode_id. We join episode_log to log the (real) embed
// cost per station in usage_log.
//
// The work list is resolved up front from two id-only scans (all transcripts,
// already-embedded episodes) so the run never downloads a VTT it will skip and
// never issues a per-episode "has chunks?" probe.

import { supabaseAdmin } from '../lib/supabase'
import { getEmbeddingModel } from '../lib/settings'
import { buildEpisodeChunkRows, storeEpisodeChunks } from '../lib/transcript-embeddings'
import { logEmbeddingUsage, OPENAI_EMBEDDING_COST_PER_TOKEN } from '../lib/usage'

function argNum(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag)
  if (i < 0) return fallback
  const n = Number(process.argv[i + 1])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const FORCE = process.argv.includes('--force')
const LIMIT = argNum('--limit', Infinity)
const CONCURRENCY = Math.floor(argNum('--concurrency', 4))
const MAX_COST = argNum('--max-cost', 3)
const PAGE = 1000

/** Page an id-only select to completion (PostgREST caps a response at 1000 rows). */
async function allIds(table: string, column: string): Promise<number[]> {
  const out: number[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(column)
      .order(column, { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to page ${table}: ${error.message}`)
    for (const r of (data ?? []) as unknown as Record<string, number>[]) out.push(Number(r[column]))
    if (!data || data.length < PAGE) break
  }
  return out
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('[backfill-embeddings] OPENAI_API_KEY is required')
    process.exit(1)
  }

  const transcriptIds = await allIds('transcripts', 'episode_id')
  // transcript_chunks has many rows per episode; the distinct set comes from the
  // idx_transcript_chunks_episode_idx unique index (episode_id, chunk_idx) — we
  // only need chunk 0 to know an episode is embedded.
  const embedded = new Set<number>()
  if (!FORCE) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('transcript_chunks')
        .select('episode_id')
        .eq('chunk_idx', 0)
        .order('episode_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`Failed to page transcript_chunks: ${error.message}`)
      for (const r of data ?? []) embedded.add(Number(r.episode_id))
      if (!data || data.length < PAGE) break
    }
  }
  const todo = transcriptIds.filter((id) => !embedded.has(id)).slice(0, LIMIT)
  console.log(
    `[backfill-embeddings] ${transcriptIds.length} transcripts, ${embedded.size} already embedded, ` +
      `${todo.length} to do (concurrency ${CONCURRENCY}, cost cap $${MAX_COST})${FORCE ? ' --force' : ''}`
  )

  const modelByStation = new Map<string, Promise<string>>()
  const modelFor = (stationId: string) => {
    let m = modelByStation.get(stationId)
    if (!m) {
      m = getEmbeddingModel(stationId)
      modelByStation.set(stationId, m)
    }
    return m
  }

  let next = 0
  let episodes = 0
  let chunksWritten = 0
  let tokens = 0
  let skipped = 0
  let failed = 0
  let stopped = false
  const started = Date.now()

  async function one(episodeId: number) {
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select('vtt, episode_log!inner(station_id)')
      .eq('episode_id', episodeId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    const row = data as { vtt: string | null; episode_log: { station_id: string } | { station_id: string }[] } | null
    if (!row?.vtt) {
      skipped++
      return
    }
    // PostgREST returns the embedded relation as an object (or array under some
    // configs) — normalize to the station_id either way.
    const rel = Array.isArray(row.episode_log) ? row.episode_log[0] : row.episode_log
    const stationId = rel?.station_id
    const model = stationId ? await modelFor(stationId) : undefined

    const { rows, tokens: t } = await buildEpisodeChunkRows(row.vtt, model)
    await storeEpisodeChunks(supabaseAdmin, episodeId, rows)
    if (t > 0 && stationId) await logEmbeddingUsage(stationId, episodeId, t, model)

    episodes++
    chunksWritten += rows.length
    tokens += t
  }

  async function lane() {
    while (!stopped && next < todo.length) {
      const id = todo[next++]
      try {
        await one(id)
      } catch (err) {
        failed++
        console.warn(`[backfill-embeddings] episode ${id} failed:`, err instanceof Error ? err.message : err)
      }
      const cost = tokens * OPENAI_EMBEDDING_COST_PER_TOKEN
      if (cost >= MAX_COST) {
        stopped = true
        console.warn(`[backfill-embeddings] cost cap reached ($${cost.toFixed(3)}) — stopping`)
      }
      const done = episodes + skipped + failed
      if (done % 50 === 0) {
        const mins = ((Date.now() - started) / 60000).toFixed(1)
        console.log(`[backfill-embeddings] ${done}/${todo.length} in ${mins}m — ${tokens} tokens ≈ $${cost.toFixed(3)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, lane))

  const cost = tokens * OPENAI_EMBEDDING_COST_PER_TOKEN
  console.log(
    `[backfill-embeddings] done — ${episodes} episodes, ${chunksWritten} chunks, ${tokens} tokens ` +
      `≈ $${cost.toFixed(3)}, ${skipped} skipped, ${failed} failed${stopped ? ' (stopped at cost cap)' : ''}`
  )
  process.exit(failed > 0 ? 2 : 0)
}

main().catch((err) => {
  console.error('[backfill-embeddings] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
