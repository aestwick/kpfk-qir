// Episode-level embedding orchestration: VTT -> timed chunks -> embeddings ->
// transcript_chunks rows. Shared by the summarize worker (live, per episode) and
// the one-time backfill so they can't drift. Depends on the pure chunker
// (lib/transcript-chunks.ts) and the OpenAI wrapper (lib/embeddings.ts).

import type { SupabaseClient } from '@supabase/supabase-js'
import type OpenAI from 'openai'
import { createHash } from 'crypto'
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

// ---------------------------------------------------------------------------
// Episode-level embeddings (migration 046) — the primary semantic index.
//
// Per-chunk embeddings (above) can't scale on this database: every row written
// into the HNSW index costs ~0.5–1.5s and the index already outgrew memory, so
// the live worker stored ~1 in 5 episodes while paying for all of them. One
// vector per episode — built from its title, host, guests, issue tags and
// summary — is ~10k rows total, needs no ANN index (an exact scan is fast and
// has perfect recall), and answers the "which shows covered X" question. The
// "where exactly was it said" half is answered by the lexical cue search, which
// already knows the moment.
// ---------------------------------------------------------------------------

/** The episode fields an episode embedding is built from. */
export interface EpisodeEmbeddingSource {
  id: number
  station_id: string
  show_name?: string | null
  title?: string | null
  headline?: string | null
  host?: string | null
  guest?: string | null
  issue_category?: string | null
  summary?: string | null
  human_summary?: string | null
}

/** Character cap on the embedded text (~1.5k tokens): summaries are well under
 *  this; the cap only guards against a pasted rundown blowing up a batch. */
const EPISODE_TEXT_MAX = 6000

/** Deterministic text for one episode's vector. Pure. Returns '' when the
 *  episode has nothing worth embedding yet (no summary and no human notes). */
export function episodeEmbeddingText(ep: EpisodeEmbeddingSource): string {
  const body = [ep.summary, ep.human_summary].map((s) => s?.trim()).filter(Boolean)
  if (!body.length) return ''
  const lines = [
    ep.show_name && `Show: ${ep.show_name}`,
    (ep.headline || ep.title) && `Title: ${ep.headline || ep.title}`,
    ep.host && `Host: ${ep.host}`,
    ep.guest && `Guests: ${ep.guest}`,
    ep.issue_category && `Issues: ${ep.issue_category}`,
    ...body,
  ].filter(Boolean) as string[]
  return lines.join('\n').slice(0, EPISODE_TEXT_MAX)
}

/** Stable hash of the embedded text + model, so unchanged episodes are never
 *  re-embedded. */
export function episodeContentHash(text: string, model: string): string {
  return createHash('sha256').update(`${model}\u0000${text}`).digest('hex').slice(0, 32)
}

export interface EpisodeEmbeddingRow {
  episode_id: number
  station_id: string
  embedding: string
  content_hash: string
  model: string
  updated_at: string
}

/** Embed a batch of episodes (one OpenAI request per ≤100 episodes) and return
 *  rows ready to upsert plus tokens billed. Episodes with no text are skipped.
 *  `knownHashes` (episode_id → stored hash) skips episodes whose text and model
 *  are unchanged. No DB writes. */
export async function buildEpisodeEmbeddingRows(
  episodes: EpisodeEmbeddingSource[],
  model: string = DEFAULT_EMBEDDING_MODEL,
  knownHashes: Map<number, string> = new Map(),
  openai?: OpenAI
): Promise<{ rows: EpisodeEmbeddingRow[]; tokens: number }> {
  const todo = episodes
    .map((ep) => {
      const text = episodeEmbeddingText(ep)
      return { ep, text, hash: text ? episodeContentHash(text, model) : '' }
    })
    .filter((x) => x.text && knownHashes.get(x.ep.id) !== x.hash)

  const rows: EpisodeEmbeddingRow[] = []
  let tokens = 0
  for (let k = 0; k < todo.length; k += 100) {
    const batch = todo.slice(k, k + 100)
    const out = await embedTexts(batch.map((b) => b.text), model, openai)
    tokens += out.tokens
    const now = new Date().toISOString()
    batch.forEach((b, i) =>
      rows.push({
        episode_id: b.ep.id,
        station_id: b.ep.station_id,
        embedding: toPgVector(out.embeddings[i]),
        content_hash: b.hash,
        model,
        updated_at: now,
      })
    )
  }
  return { rows, tokens }
}

/** Upsert episode embeddings (no ANN index on the table, so this is a plain
 *  heap write — fast in any batch size). */
export async function storeEpisodeEmbeddings(client: SupabaseClient, rows: EpisodeEmbeddingRow[]): Promise<void> {
  for (let k = 0; k < rows.length; k += 100) {
    const { error } = await client.from('episode_embeddings').upsert(rows.slice(k, k + 100), { onConflict: 'episode_id' })
    if (error) throw new Error(error.message)
  }
}
