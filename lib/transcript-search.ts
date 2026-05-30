// Transcript search query construction (Phase 1, lexical FTS).
//
// Thin wrapper over the search_transcripts() RPC (migration 022): builds the
// args, resolves a quarter to a date range, and shapes rows into
// TranscriptSearchResult. No SQL here beyond the .rpc() call — ranking, the
// ts_headline snippet, station scoping and the cue join all live in the RPC so
// the route stays thin (see ideas/TRANSCRIPT_SEARCH_SPEC.md §13).

import type { SupabaseClient } from '@supabase/supabase-js'
import { getQuarterDateRange } from './qir-format'
import type { TranscriptSearchResult } from './types'

// websearch_to_tsquery ignores 1-char tokens anyway; require at least 2 so a
// stray keystroke never fires a query (spec §7.1).
export const MIN_QUERY_LENGTH = 2
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export interface TranscriptSearchParams {
  stationId: string
  query: string
  showKey?: string | null
  /** "YYYY-Q[1-4]" — convenience that expands to start/end below. */
  quarter?: string | null
  startDate?: string | null
  endDate?: string | null
  page?: number
  limit?: number
}

/** Expand "2026-Q1" to its inclusive date range, reusing the QIR helper. */
function quarterToRange(quarter?: string | null): { start: string | null; end: string | null } {
  if (!quarter) return { start: null, end: null }
  const m = quarter.match(/^(\d{4})-Q([1-4])$/)
  if (!m) return { start: null, end: null }
  const { start, end } = getQuarterDateRange(parseInt(m[1], 10), parseInt(m[2], 10))
  return { start, end }
}

interface SearchRow {
  episode_id: number
  show_key: string
  show_name: string | null
  air_date: string | null
  status: string
  rank: number
  snippet: string
  start_ms: number | null
  total_count: number
}

export async function searchTranscripts(
  supabase: SupabaseClient,
  params: TranscriptSearchParams
): Promise<{ results: TranscriptSearchResult[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page = Math.max(params.page ?? 1, 1)
  const offset = (page - 1) * limit

  // An explicit start/end date wins over the quarter shortcut when both arrive.
  const range = quarterToRange(params.quarter)
  const startDate = params.startDate || range.start
  const endDate = params.endDate || range.end

  const { data, error } = await supabase.rpc('search_transcripts', {
    p_station_id: params.stationId,
    p_query: params.query,
    p_show_key: params.showKey || null,
    p_start_date: startDate,
    p_end_date: endDate,
    p_limit: limit,
    p_offset: offset,
  })

  if (error) throw new Error(error.message)

  const rows = (data ?? []) as SearchRow[]
  // total_count rides on every row (window-wide count); 0 rows -> 0 total.
  const total = rows.length > 0 ? Number(rows[0].total_count) : 0

  const results: TranscriptSearchResult[] = rows.map((r) => ({
    episodeId: Number(r.episode_id),
    showKey: r.show_key,
    showName: r.show_name,
    airDate: r.air_date,
    status: r.status,
    rank: Number(r.rank),
    snippet: r.snippet ?? '',
    startMs: r.start_ms == null ? null : Number(r.start_ms),
  }))

  return { results, total }
}
