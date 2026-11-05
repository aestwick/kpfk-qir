// Backfill episode-level embeddings (migration 046, public.episode_embeddings)
// — the index behind "Smart" search. One vector per summarized episode, built
// from its show, title, host, guests, issue tags and summary
// (lib/transcript-embeddings.ts#episodeEmbeddingText). Re-runnable: episodes
// whose text + model are unchanged (content_hash) are skipped, so a re-run
// only pays for new or edited episodes.
//
// Usage:
//   tsx scripts/backfill-episode-embeddings.ts                  # all stations
//   tsx scripts/backfill-episode-embeddings.ts --max-cost 0.50  # spend cap (default $1)
//
// Cost: ~300–600 tokens per episode at text-embedding-3-small ($0.02/M) —
// roughly $0.06 for 6,000 episodes. Logged to usage_log (operation 'embed').

import { supabaseAdmin } from '../lib/supabase'
import { getEmbeddingModel } from '../lib/settings'
import {
  buildEpisodeEmbeddingRows,
  storeEpisodeEmbeddings,
  EPISODE_EMBEDDING_FIELDS,
  type EpisodeEmbeddingSource,
} from '../lib/transcript-embeddings'
import { logEmbeddingUsage, OPENAI_EMBEDDING_COST_PER_TOKEN } from '../lib/usage'

const i = process.argv.indexOf('--max-cost')
const MAX_COST = i >= 0 ? Number(process.argv[i + 1]) || 1 : 1
const PAGE = 500

async function storedHashes(stationId: string): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from('episode_embeddings')
      .select('episode_id, content_hash')
      .eq('station_id', stationId)
      .order('episode_id')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data ?? []) out.set(Number(r.episode_id), r.content_hash)
    if (!data || data.length < 1000) break
  }
  return out
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required')
  const { data: stations, error } = await supabaseAdmin.from('stations').select('id, slug')
  if (error) throw new Error(error.message)

  let totalTokens = 0
  let totalRows = 0
  for (const s of stations ?? []) {
    const model = await getEmbeddingModel(s.id)
    const known = await storedHashes(s.id)
    let stationRows = 0
    for (let from = 0; ; from += PAGE) {
      const { data: eps, error: e2 } = await supabaseAdmin
        .from('episode_log')
        .select(EPISODE_EMBEDDING_FIELDS)
        .eq('station_id', s.id)
        .or('summary.not.is.null,human_summary.not.is.null')
        .neq('status', 'archived')
        .order('id')
        .range(from, from + PAGE - 1)
      if (e2) throw new Error(e2.message)
      if (!eps?.length) break

      const { rows, tokens } = await buildEpisodeEmbeddingRows(eps as EpisodeEmbeddingSource[], model, known)
      await storeEpisodeEmbeddings(supabaseAdmin, rows)
      if (tokens > 0) await logEmbeddingUsage(s.id, null, tokens, model, { backfill: 'episode_embeddings', episodes: rows.length })
      totalTokens += tokens
      stationRows += rows.length
      const cost = totalTokens * OPENAI_EMBEDDING_COST_PER_TOKEN
      console.log(`[episode-embeddings] ${s.slug}: +${rows.length} (page ${from / PAGE + 1}) — ${totalTokens} tokens ≈ $${cost.toFixed(4)}`)
      if (cost >= MAX_COST) {
        console.warn(`[episode-embeddings] cost cap $${MAX_COST} reached — stopping`)
        process.exit(0)
      }
      if (eps.length < PAGE) break
    }
    totalRows += stationRows
  }
  console.log(
    `[episode-embeddings] done — ${totalRows} episodes embedded, ${totalTokens} tokens ≈ $${(totalTokens * OPENAI_EMBEDDING_COST_PER_TOKEN).toFixed(4)}`
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[episode-embeddings] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
