// Episode-level embedding orchestration: VTT -> timed chunks -> embeddings ->
// transcript_chunks rows. Shared by the summarize worker (live, per episode) and
// the one-time backfill so they can't drift. Depends on the pure chunker
// (lib/transcript-chunks.ts) and the OpenAI wrapper (lib/embeddings.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import type OpenAI from 'openai'
import { parseVtt } from './vtt'
import { chunkCues } from './transcript-chunks'
import { embedTexts, toPgVector, DEFAULT_EMBEDDING_MODEL } from './embeddings'

// A transcript_chunks row minus episode_id (added at store time). embedding is the
// pgvector text literal.
export interface ChunkEmbeddingRow {
  chunk_idx: number
  start_ms: number
  end_ms: number
  content: string
  embedding: string
}

/** Parse a VTT, chunk it, and embed every chunk in one request. Returns the rows
 *  ready to store plus the tokens billed (for usage logging). No DB writes. */
export async function buildEpisodeChunkRows(
  vtt: string | null | undefined,
  model: string = DEFAULT_EMBEDDING_MODEL,
  openai?: OpenAI
): Promise<{ rows: ChunkEmbeddingRow[]; tokens: number }> {
  const chunks = chunkCues(parseVtt(vtt))
  if (!chunks.length) return { rows: [], tokens: 0 }

  const { embeddings, tokens } = await embedTexts(
    chunks.map((c) => c.content),
    model,
    openai
  )

  const rows = chunks.map((c, i) => ({
    chunk_idx: c.chunkIdx,
    start_ms: c.startMs,
    end_ms: c.endMs,
    content: c.content,
    embedding: toPgVector(embeddings[i]),
  }))
  return { rows, tokens }
}

/** Replace an episode's chunks (idempotent per episode: clear then insert, like
 *  the cue populate in workers/transcribe.ts). */
export async function storeEpisodeChunks(
  client: SupabaseClient,
  episodeId: number,
  rows: ChunkEmbeddingRow[]
): Promise<void> {
  await client.from('transcript_chunks').delete().eq('episode_id', episodeId)
  if (!rows.length) return
  const withEpisode = rows.map((r) => ({ episode_id: episodeId, ...r }))
  for (let k = 0; k < withEpisode.length; k += 200) {
    const { error } = await client.from('transcript_chunks').insert(withEpisode.slice(k, k + 200))
    if (error) throw new Error(error.message)
  }
}
