// Database loaders for transcript correction rules and the per-show name list,
// shared by the transcribe worker and the corrections worker. Service-role
// callers: every query filters by station_id (the only tenancy guard here).

import type { SupabaseClient } from '@supabase/supabase-js'
import { showGroupKey } from '../shows'
import type { Correction, ShowGroupLookup } from './corrections'
import { splitPersonNames } from './names'

export interface StoredCorrection extends Correction {
  id: number
  backfilledAt: string | null
}

/** Every ACTIVE rule for a station, in creation order (the order they apply). */
export async function loadCorrectionRules(
  client: SupabaseClient,
  stationId: string,
): Promise<StoredCorrection[]> {
  const { data, error } = await client
    .from('transcript_corrections')
    .select('id, wrong, correct, case_sensitive, is_regex, episode_id, show_key, backfilled_at')
    .eq('station_id', stationId)
    .eq('active', true)
    .order('id', { ascending: true })
  if (error) throw new Error(`Failed to load corrections: ${error.message}`)
  return (data ?? []).map((c) => ({
    id: c.id,
    wrong: c.wrong,
    correct: c.correct,
    caseSensitive: !!c.case_sensitive,
    isRegex: !!c.is_regex,
    episodeId: c.episode_id,
    showKey: c.show_key,
    backfilledAt: c.backfilled_at,
  }))
}

/** key → show-group identity (lib/shows.ts#showGroupKey) for a station, as a
 *  lookup; unknown keys are their own group. Also returns the keys per group. */
export async function loadShowGroups(
  client: SupabaseClient,
  stationId: string,
): Promise<{ groupOf: ShowGroupLookup; keysInGroup: (showKey: string) => string[] }> {
  const { data, error } = await client
    .from('show_keys')
    .select('key, show_group')
    .eq('station_id', stationId)
  if (error) throw new Error(`Failed to load show groups: ${error.message}`)
  const byKey = new Map<string, string>()
  const byGroup = new Map<string, string[]>()
  for (const row of data ?? []) {
    const g = showGroupKey(row)
    byKey.set(row.key, g)
    byGroup.set(g, [...(byGroup.get(g) ?? []), row.key])
  }
  const groupOf: ShowGroupLookup = (key) => byKey.get(key) ?? key.toLowerCase()
  return {
    groupOf,
    keysInGroup: (key) => byGroup.get(groupOf(key)) ?? [key],
  }
}

export interface StationVocabulary {
  stationTerms: string[]
  /** Names for an episode's show — every active name on any feed of its group. */
  namesForShow: (showKey: string | null | undefined) => string[]
}

/** The station's ACTIVE name list, grouped by show group. */
export async function loadVocabulary(
  client: SupabaseClient,
  stationId: string,
  groupOf: ShowGroupLookup,
): Promise<StationVocabulary> {
  const { data, error } = await client
    .from('transcript_vocabulary')
    .select('show_key, name')
    .eq('station_id', stationId)
    .eq('active', true)
    .order('id', { ascending: true })
  if (error) throw new Error(`Failed to load vocabulary: ${error.message}`)
  const stationTerms: string[] = []
  const byGroup = new Map<string, string[]>()
  for (const row of data ?? []) {
    if (!row.show_key) {
      stationTerms.push(row.name)
      continue
    }
    const g = groupOf(row.show_key)
    byGroup.set(g, [...(byGroup.get(g) ?? []), row.name])
  }
  return {
    stationTerms,
    namesForShow: (key) => (key ? byGroup.get(groupOf(key)) ?? [] : []),
  }
}

type FieldSourcesLike = Record<string, { human?: unknown } | undefined> | null | undefined

/** Names a producer typed for THIS episode in Confessor (human copies only —
 *  the AI copies come from the transcript and would just echo its errors). */
export function episodeHumanNames(fieldSources: FieldSourcesLike): string[] {
  const out: string[] = []
  for (const field of ['host', 'guest']) {
    const human = fieldSources?.[field]?.human
    if (typeof human === 'string') out.push(...splitPersonNames(human))
  }
  return out
}
