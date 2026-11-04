// Compliance blocking — the single definition of "which episodes are held out
// of a QIR draft", shared by the generator (workers/generate-qir.ts) and every
// UI surface that reports on it (Generate page, Overview card).
//
// The rule (owner-set, see CLAUDE.md "Compliance config is centralized"): when
// `compliance_blocking` is on, an episode is held out if it has ANY flag with
// severity 'critical' whose review_status is anything other than 'dismissed'.
// That deliberately includes untriaged 'suggested' flags — blocking fails safe
// until a human clears the flag. This is NOT the same set as the "active
// offense" counts (investigating + violation, lib/compliance-status.ts), which
// is why the UI used to say "no active flags" while episodes were being held.
//
// Do not change the predicate here without the owner's sign-off.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReviewStatus } from './compliance-status'

export const BLOCKING_SEVERITY = 'critical'
/** The only review status that releases a critical flag's hold. */
export const RELEASING_REVIEW_STATUS: ReviewStatus = 'dismissed'

/** Statuses the generator treats as published-ready QIR candidates. */
export const QIR_CANDIDATE_STATUSES = ['summarized', 'compliance_checked'] as const

export interface BlockingFlagRow {
  episode_id: number
  flag_type: string
  review_status: string | null
}

export function isBlockingFlag(flag: { severity: string | null; review_status: string | null }): boolean {
  return flag.severity === BLOCKING_SEVERITY && flag.review_status !== RELEASING_REVIEW_STATUS
}

export interface BlockedEpisodeSummary {
  episode_id: number
  flag_count: number
  /** Flags still in 'suggested' — nobody has looked at them yet. */
  unreviewed_count: number
  flag_types: string[]
}

/** Group blocking flag rows by episode (pure; input already filtered). */
export function summarizeBlockingFlags(flags: BlockingFlagRow[]): BlockedEpisodeSummary[] {
  const byEpisode = new Map<number, BlockedEpisodeSummary>()
  for (const f of flags) {
    let s = byEpisode.get(f.episode_id)
    if (!s) {
      s = { episode_id: f.episode_id, flag_count: 0, unreviewed_count: 0, flag_types: [] }
      byEpisode.set(f.episode_id, s)
    }
    s.flag_count++
    if (f.review_status === 'suggested' || f.review_status == null) s.unreviewed_count++
    if (!s.flag_types.includes(f.flag_type)) s.flag_types.push(f.flag_type)
  }
  return Array.from(byEpisode.values()).sort((a, b) => a.episode_id - b.episode_id)
}

/**
 * Blocking flags (critical, not dismissed) on the given episodes. Chunked:
 * ~2000 ids in one `in.(…)` overflows the request URL.
 */
export async function fetchBlockingFlags(
  client: SupabaseClient,
  episodeIds: number[],
): Promise<BlockingFlagRow[]> {
  const out: BlockingFlagRow[] = []
  for (let i = 0; i < episodeIds.length; i += 200) {
    const { data, error } = await client
      .from('compliance_flags')
      .select('episode_id, flag_type, review_status')
      .in('episode_id', episodeIds.slice(i, i + 200))
      .eq('severity', BLOCKING_SEVERITY)
      .neq('review_status', RELEASING_REVIEW_STATUS)
    if (error) throw new Error(`Failed to fetch compliance flags: ${error.message}`)
    out.push(...((data ?? []) as BlockingFlagRow[]))
  }
  return out
}

/**
 * The generator's candidate set for a quarter: summarized/compliance_checked
 * episodes airing in [start, end], plus null-air_date episodes created in it.
 * Paged — PostgREST caps a response at 1000 rows and a quarter runs ~2000.
 */
export async function fetchQuarterCandidates<T = Record<string, unknown>>(
  client: SupabaseClient,
  stationId: string,
  start: string,
  end: string,
  columns = '*',
): Promise<T[]> {
  const PAGE = 1000
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data: page, error } = await client
      .from('episode_log')
      .select(columns)
      .eq('station_id', stationId)
      .in('status', [...QIR_CANDIDATE_STATUSES])
      .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
      .order('air_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
    rows.push(...((page ?? []) as T[]))
    if (!page || page.length < PAGE) break
  }
  return rows
}

export interface HeldOutEpisode extends BlockedEpisodeSummary {
  show_name: string | null
  air_date: string | null
  headline: string | null
}

export interface QuarterBlockingReport {
  /** Whether the compliance_blocking gate is on right now. */
  enabled: boolean
  /** Episodes the generator would hold out of a draft for this quarter right now. */
  episodes: HeldOutEpisode[]
  flag_count: number
  unreviewed_count: number
}

/**
 * Live view of what blocking holds out for a quarter — computed with the same
 * candidate query and flag predicate the generator uses. Computed even when
 * blocking is off (enabled=false) so callers can say "would hold out N".
 */
export async function getQuarterBlockingReport(
  client: SupabaseClient,
  stationId: string,
  start: string,
  end: string,
  enabled: boolean,
): Promise<QuarterBlockingReport> {
  const candidates = await fetchQuarterCandidates<{
    id: number; show_name: string | null; air_date: string | null; headline: string | null
  }>(client, stationId, start, end, 'id, show_name, air_date, headline')
  const flags = await fetchBlockingFlags(client, candidates.map((c) => c.id))
  const byId = new Map(candidates.map((c) => [c.id, c]))
  const episodes = summarizeBlockingFlags(flags).map((s) => {
    const ep = byId.get(s.episode_id)
    return { ...s, show_name: ep?.show_name ?? null, air_date: ep?.air_date ?? null, headline: ep?.headline ?? null }
  })
  episodes.sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? '') || a.episode_id - b.episode_id)
  return {
    enabled,
    episodes,
    flag_count: episodes.reduce((n, e) => n + e.flag_count, 0),
    unreviewed_count: episodes.reduce((n, e) => n + e.unreviewed_count, 0),
  }
}
