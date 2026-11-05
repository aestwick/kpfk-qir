// Transcript search (server-side). Builds a forgiving query, runs the
// index-backed search RPCs from migration 046/047, and shapes results.
//
//   Exact words (default, free): parse the box → look up each word's real
//     spellings in the station vocabulary (accents, plurals, likely typos) →
//     search_transcripts_v2() with the expanded tsquery. When no episode has
//     every word, retry with "most of the words" and say so (`relaxed`).
//   Smart (one OpenAI embed per query, ~$0.000001): the exact pass above fused
//     (reciprocal-rank) with the nearest episodes by meaning from
//     episode_embeddings; meaning-only hits get their moment from
//     episode_moments().
//
// Every RPC is SECURITY DEFINER with an explicit station-membership check, and
// we also pass the active station id — same defense in depth as the rest of
// the app. See supabase/migrations/046_search_views.sql for why (RLS forced a
// 22s sequential scan).

import type { SupabaseClient } from '@supabase/supabase-js'
import { quarterParamRange } from './qir-format'
import { embedQuery, toPgVector } from './embeddings'
import { getEmbeddingModel } from './settings'
import type { TranscriptSearchResult } from './types'
import {
  parseSearchQuery,
  lookupWords,
  chooseVariants,
  alsoMatched,
  buildTsQuery,
  reciprocalRankFusion,
  type VariantRow,
} from './search-query'

export const MIN_QUERY_LENGTH = 2
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export type SearchMode = 'lexical' | 'semantic'

export interface TranscriptSearchParams {
  stationId: string
  query: string
  /** Feed keys of one logical show (a show group spans several keys). */
  showKeys?: string[] | null
  /** "YYYY-Q[1-4]" — convenience that expands to start/end below. */
  quarter?: string | null
  startDate?: string | null
  endDate?: string | null
  page?: number
  limit?: number
  /** Page 2+ of a relaxed ("most of the words") result set. */
  relaxed?: boolean
}

export interface TranscriptSearchResponse {
  results: TranscriptSearchResult[]
  total: number
  /** Spellings searched beyond what was typed ("Hartman", "movilización"). */
  alsoMatched: string[]
  /** True when no episode had every word and we fell back to most words. */
  relaxed: boolean
  /** Smart mode only: embedding failed, served exact results instead. */
  degraded?: boolean
}

/** Expand "2026-Q1" to its inclusive date range, reusing the QIR helper. */
function quarterToRange(quarter?: string | null): { start: string | null; end: string | null } {
  return quarterParamRange(quarter) ?? { start: null, end: null }
}

function resolveArgs(params: TranscriptSearchParams) {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page = Math.max(params.page ?? 1, 1)
  const range = quarterToRange(params.quarter)
  return {
    limit,
    offset: (page - 1) * limit,
    startDate: params.startDate || range.start,
    endDate: params.endDate || range.end,
    showKeys: params.showKeys && params.showKeys.length ? params.showKeys : null,
  }
}

interface V2Row {
  episode_id: number
  show_key: string
  show_name: string | null
  air_date: string | null
  air_start: string | null
  host: string | null
  guest: string | null
  status: string
  rank: number
  snippet: string | null
  start_ms: number | null
  cue_snippet: string | null
  total_count: number
}

function shapeV2(r: V2Row, matchType: 'lexical' | 'semantic' = 'lexical'): TranscriptSearchResult {
  return {
    episodeId: Number(r.episode_id),
    showKey: r.show_key,
    showName: r.show_name,
    airDate: r.air_date,
    airStart: r.air_start,
    host: r.host,
    guest: r.guest,
    status: r.status,
    rank: Number(r.rank),
    snippet: r.snippet ?? '',
    momentText: r.cue_snippet,
    startMs: r.start_ms == null ? null : Number(r.start_ms),
    matchType,
  }
}

/** Build the expanded tsquery for a typed query (one vocabulary RPC). */
export async function buildStationQuery(supabase: SupabaseClient, stationId: string, query: string) {
  const parsed = parseSearchQuery(query)
  const words = lookupWords(parsed)
  let rows: VariantRow[] = []
  if (words.length) {
    const { data, error } = await supabase.rpc('search_vocab_variants', { p_station_id: stationId, p_terms: words })
    // A missing vocabulary only costs forgiveness, never the search itself.
    if (!error) rows = (data ?? []) as VariantRow[]
    else console.warn('[transcript-search] vocab lookup failed:', error.message)
  }
  const variants = chooseVariants(words, rows)
  return { built: buildTsQuery(parsed, variants), also: alsoMatched(variants) }
}

async function runV2(
  supabase: SupabaseClient,
  stationId: string,
  tsquery: string,
  anyQuery: string | null,
  a: ReturnType<typeof resolveArgs>,
  limit = a.limit,
  offset = a.offset
): Promise<V2Row[]> {
  const { data, error } = await supabase.rpc('search_transcripts_v2', {
    p_station_id: stationId,
    p_tsquery: tsquery,
    p_any_tsquery: anyQuery,
    p_show_keys: a.showKeys,
    p_start_date: a.startDate,
    p_end_date: a.endDate,
    p_limit: limit,
    p_offset: offset,
  })
  if (error) throw new SearchError(error.message, error.code)
  return (data ?? []) as V2Row[]
}

/** Raised for DB failures so the route can tell "too broad / timed out" from
 *  other errors and say something useful instead of "no matches". */
export class SearchError extends Error {
  constructor(message: string, public code?: string) {
    super(message)
  }
  get timedOut(): boolean {
    return this.code === '57014' || /statement timeout/i.test(this.message)
  }
}

/** Exact-words search (the default). */
export async function searchTranscripts(
  supabase: SupabaseClient,
  params: TranscriptSearchParams
): Promise<TranscriptSearchResponse> {
  const a = resolveArgs(params)
  const { built, also } = await buildStationQuery(supabase, params.stationId, params.query)
  if (!built) return { results: [], total: 0, alsoMatched: [], relaxed: false }

  // Relaxed paging: page 1 decided the strict query matched nothing, so later
  // pages (flagged by the client) go straight to the relaxed query.
  let relaxed = Boolean(params.relaxed && built.any)
  let rows = await runV2(supabase, params.stationId, relaxed ? built.any! : built.all, built.any, a)
  if (!rows.length && !relaxed && built.any && a.offset === 0) {
    rows = await runV2(supabase, params.stationId, built.any, built.any, a)
    relaxed = rows.length > 0
  }
  return {
    results: rows.map((r) => shapeV2(r)),
    total: rows.length ? Number(rows[0].total_count) : 0,
    alsoMatched: also,
    relaxed,
  }
}

interface MomentRow {
  episode_id: number
  start_ms: number | null
  cue_text: string | null
}

/** Smart search: exact-words results fused with meaning-matched episodes. */
export async function searchTranscriptsSemantic(
  supabase: SupabaseClient,
  params: TranscriptSearchParams
): Promise<TranscriptSearchResponse> {
  const a = resolveArgs(params)
  let embedding: number[]
  try {
    const model = await getEmbeddingModel(params.stationId)
    embedding = (await embedQuery(params.query, model)).embedding
  } catch (err) {
    console.warn('[transcript-search] query embedding failed, falling back to exact:', err instanceof Error ? err.message : err)
    return { ...(await searchTranscripts(supabase, params)), degraded: true }
  }

  const { built, also } = await buildStationQuery(supabase, params.stationId, params.query)
  const pool = 50
  // Keyword side of the fusion: episodes with ALL the words first; only when
  // none has them all, fall back to ANY word. ANY-word matching on its own
  // flooded concept searches with noise ("grief over the climate crisis" →
  // every news segment that says "climate").
  const lexical = async (): Promise<V2Row[]> => {
    if (!built) return []
    const strict = await runV2(supabase, params.stationId, built.all, built.any, a, pool, 0)
    if (strict.length || !built.any) return strict
    return runV2(supabase, params.stationId, built.any, built.any, a, pool, 0)
  }
  const [lexRows, sem] = await Promise.all([
    lexical(),
    supabase.rpc('search_episodes_semantic', {
      p_station_id: params.stationId,
      p_embedding: toPgVector(embedding),
      p_show_keys: a.showKeys,
      p_start_date: a.startDate,
      p_end_date: a.endDate,
      p_limit: pool,
    }),
  ])
  if (sem.error) throw new SearchError(sem.error.message, sem.error.code)
  const semIds = ((sem.data ?? []) as { episode_id: number }[]).map((r) => Number(r.episode_id))
  const fused = reciprocalRankFusion([lexRows.map((r) => Number(r.episode_id)), semIds])
  const pageIds = fused.slice(a.offset, a.offset + a.limit).map((f) => f.id)

  const lexById = new Map(lexRows.map((r) => [Number(r.episode_id), r]))
  const missing = pageIds.filter((id) => !lexById.has(id))
  const moments = new Map<number, MomentRow>()
  const meta = new Map<number, Record<string, unknown>>()
  if (missing.length) {
    const [mom, eps] = await Promise.all([
      supabase.rpc('episode_moments', {
        p_station_id: params.stationId,
        p_episode_ids: missing,
        p_any_tsquery: built?.any ?? built?.all ?? null,
        p_embedding: toPgVector(embedding),
      }),
      supabase
        .from('episode_log')
        .select('id, show_key, show_name, air_date, air_start, host, guest, status, headline, summary')
        .eq('station_id', params.stationId)
        .in('id', missing),
    ])
    for (const m of (mom.data ?? []) as MomentRow[]) moments.set(Number(m.episode_id), m)
    for (const e of (eps.data ?? []) as Record<string, unknown>[]) meta.set(Number(e.id), e)
  }

  const results: TranscriptSearchResult[] = []
  for (const id of pageIds) {
    const lx = lexById.get(id)
    if (lx) {
      results.push(shapeV2(lx))
      continue
    }
    const e = meta.get(id)
    if (!e) continue
    const m = moments.get(id)
    results.push({
      episodeId: id,
      showKey: String(e.show_key),
      showName: (e.show_name as string) ?? null,
      airDate: (e.air_date as string) ?? null,
      airStart: (e.air_start as string) ?? null,
      host: (e.host as string) ?? null,
      guest: (e.guest as string) ?? null,
      status: String(e.status),
      rank: 0,
      // Meaning matches have no highlighted words: show what the episode is about.
      snippet: String(e.headline ?? e.summary ?? '').slice(0, 280),
      momentText: m?.cue_text ?? null,
      startMs: m?.start_ms ?? null,
      matchType: 'semantic',
    })
  }
  return { results, total: fused.length, alsoMatched: also, relaxed: false, degraded: false }
}

/** Fold new transcripts into the station's search vocabulary, in batches,
 *  until caught up (or `maxBatches`). Service-role only. Returns the number of
 *  transcripts processed. */
export async function refreshSearchVocab(
  admin: SupabaseClient,
  stationId: string,
  opts: { batch?: number; maxBatches?: number; onBatch?: (done: number) => void } = {}
): Promise<number> {
  const batch = opts.batch ?? 100
  let done = 0
  for (let i = 0; i < (opts.maxBatches ?? Infinity); i++) {
    const { data, error } = await admin.rpc('refresh_search_vocab', { p_station_id: stationId, p_batch: batch })
    if (error) throw new Error(error.message)
    const n = Number(data ?? 0)
    done += n
    opts.onBatch?.(done)
    if (n < batch) break
  }
  return done
}
