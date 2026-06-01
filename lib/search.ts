// Non-transcript search scopes for the Search page.
//
// Transcript search has its own rich, ranked, audio-deep-linked path
// (lib/transcript-search.ts + the search_transcripts RPCs). The other scopes —
// episode summaries, episode metadata, and shows — are simpler ilike scans over
// the already-loaded columns, so they live here as thin Supabase queries. Each
// is scoped to the active station via the request-scoped RLS client AND an
// explicit station_id filter (defense in depth), mirroring the rest of the app.

import type { SupabaseClient } from '@supabase/supabase-js'
import { getQuarterDateRange } from './qir-format'
import { resolveShowDisplayName } from './shows'

export const MIN_QUERY_LENGTH = 2
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100
// How many rows each section returns in the combined "All" view.
export const ALL_PREVIEW_LIMIT = 5

export interface ScopeSearchParams {
  stationId: string
  query: string
  showKey?: string | null
  /** "YYYY-Q[1-4]" — expands to an air_date range. */
  quarter?: string | null
  page?: number
  limit?: number
}

export interface SummaryResult {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string | null
  status: string
  snippet: string
}

export interface EpisodeResult {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string | null
  status: string
  headline: string | null
  host: string | null
  guest: string | null
  category: string | null
}

export interface ShowResult {
  key: string
  display: string
  category: string | null
  active: boolean
}

function paginate(p: ScopeSearchParams) {
  const limit = Math.min(Math.max(p.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const page = Math.max(p.page ?? 1, 1)
  return { limit, offset: (page - 1) * limit }
}

/** ilike pattern, with PostgREST or()-breaking characters stripped from the term
 *  (commas, parens and quotes split the filter list). */
function likePattern(query: string): string | null {
  const term = query.replace(/[,()"]/g, ' ').trim()
  return term ? `%${term}%` : null
}

/** Apply a quarter ("YYYY-Q1") as an air_date range, falling back to created_at
 *  for episodes with a null air_date — same rule as GET /api/episodes. */
function applyQuarter<T>(query: T, quarter?: string | null): T {
  const m = quarter?.match(/^(\d{4})-Q([1-4])$/)
  if (!m) return query
  const { start, end } = getQuarterDateRange(parseInt(m[1], 10), parseInt(m[2], 10))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (query as any).or(
    `and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`
  )
}

/** A ~240-char window of `text` centered on the first match of `query`, so the
 *  matched phrase is visible. Falls back to the head of the text. Highlighting
 *  is done client-side. */
function makeSnippet(text: string | null, query: string, radius = 120): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  const term = query.trim().toLowerCase()
  const idx = term ? clean.toLowerCase().indexOf(term) : -1
  if (idx < 0) return clean.length > radius * 2 ? clean.slice(0, radius * 2) + '…' : clean
  const start = Math.max(0, idx - radius)
  const end = Math.min(clean.length, idx + term.length + radius)
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}

/** Search episode summaries (and headlines). Only episodes that have a summary
 *  are eligible — that's the whole point of this scope. */
export async function searchSummaries(
  supabase: SupabaseClient,
  p: ScopeSearchParams
): Promise<{ results: SummaryResult[]; total: number }> {
  const like = likePattern(p.query)
  if (!like) return { results: [], total: 0 }
  const { limit, offset } = paginate(p)

  let query = supabase
    .from('episode_log')
    .select('id, show_key, show_name, air_date, status, headline, summary', { count: 'exact' })
    .eq('station_id', p.stationId)
    .not('summary', 'is', null)
  if (p.showKey) query = query.eq('show_key', p.showKey)
  query = applyQuarter(query, p.quarter)
  query = query
    .or(`summary.ilike.${like},headline.ilike.${like}`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) throw new Error(error.message)

  const results: SummaryResult[] = (data ?? []).map((r) => ({
    episodeId: r.id,
    showKey: r.show_key,
    showName: r.show_name,
    airDate: r.air_date,
    status: r.status,
    snippet: makeSnippet(r.summary, p.query) || (r.headline ?? ''),
  }))
  return { results, total: count ?? 0 }
}

/** Search episode metadata: show name, headline, host, guest, issue category. */
export async function searchEpisodes(
  supabase: SupabaseClient,
  p: ScopeSearchParams
): Promise<{ results: EpisodeResult[]; total: number }> {
  const like = likePattern(p.query)
  if (!like) return { results: [], total: 0 }
  const { limit, offset } = paginate(p)

  let query = supabase
    .from('episode_log')
    .select('id, show_key, show_name, air_date, status, headline, host, guest, issue_category', { count: 'exact' })
    .eq('station_id', p.stationId)
  if (p.showKey) query = query.eq('show_key', p.showKey)
  query = applyQuarter(query, p.quarter)
  query = query
    .or(`show_name.ilike.${like},headline.ilike.${like},host.ilike.${like},guest.ilike.${like},issue_category.ilike.${like}`)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const { data, error, count } = await query
  if (error) throw new Error(error.message)

  const results: EpisodeResult[] = (data ?? []).map((r) => ({
    episodeId: r.id,
    showKey: r.show_key,
    showName: r.show_name,
    airDate: r.air_date,
    status: r.status,
    headline: r.headline,
    host: r.host,
    guest: r.guest,
    category: r.issue_category,
  }))
  return { results, total: count ?? 0 }
}

/** Search the station's shows by any of their names/keys. Time filters don't
 *  apply to shows, so quarter/show_key are ignored here. */
export async function searchShows(
  supabase: SupabaseClient,
  p: ScopeSearchParams
): Promise<{ results: ShowResult[]; total: number }> {
  const like = likePattern(p.query)
  if (!like) return { results: [], total: 0 }
  const { limit, offset } = paginate(p)

  const [{ data, error, count }, { data: station }] = await Promise.all([
    supabase
      .from('show_keys')
      .select('key, show_name, feed_name, display_name, show_group, category, active', { count: 'exact' })
      .eq('station_id', p.stationId)
      .or(`show_name.ilike.${like},feed_name.ilike.${like},display_name.ilike.${like},key.ilike.${like},show_group.ilike.${like}`)
      .order('show_name')
      .range(offset, offset + limit - 1),
    supabase.from('stations').select('show_name_strip_prefixes').eq('id', p.stationId).maybeSingle(),
  ])
  if (error) throw new Error(error.message)
  const stripPrefixes = station?.show_name_strip_prefixes ?? null

  const results: ShowResult[] = (data ?? []).map((r) => ({
    key: r.key,
    display: resolveShowDisplayName(r, stripPrefixes),
    category: r.category,
    active: r.active,
  }))
  return { results, total: count ?? 0 }
}
