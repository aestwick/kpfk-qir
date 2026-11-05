// Re-apply correction rules to transcripts that are ALREADY stored.
//
// Rules used to touch only future transcripts, so a fix added today left every
// past episode misspelled — invisible to search. A rule now carries
// `backfilled_at` (migration 047): null means "not yet re-applied". This module
// finds the stored transcripts each pending rule would change, rewrites the
// transcript text and the captions (cue text only — never timings or speaker
// tags), rebuilds the search cues, re-embeds the semantic-search chunks when
// the episode had them, and stamps the rule. Ace pre-approved this for the
// existing active rules; new rules only exist once a person creates or
// approves them, so nothing reaches stored text without a human decision.
//
// Text-only: no audio is re-transcribed. Idempotent: re-running finds nothing
// left to change. Summaries are not rewritten (re-summarize regenerates them).
// Known limit: no lock against the transcribe worker — a re-transcription that
// commits between this read and write would be overwritten with the corrected
// OLD text. The window is seconds; re-transcribe again if it ever happens.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyCorrections,
  applyCorrectionsToVtt,
  correctionsForEpisode,
  isSelfReapplying,
  toPrefilterPattern,
} from './corrections'
import { replaceEpisodeCues } from './cues'
import { loadCorrectionRules, loadShowGroups, type StoredCorrection } from './store'
import { buildEpisodeChunkRows, storeEpisodeChunks } from '../transcript-embeddings'
import { isEmbeddingsEnabled, getEmbeddingModel } from '../settings'
import { logEmbeddingUsage } from '../usage'
import { bumpCacheVersion } from '../api-cache'

export interface BackfillOptions {
  /** false = dry run: count what would change, write nothing. */
  apply: boolean
  /** Restrict to these rule ids (default: every pending rule). */
  ruleIds?: number[]
}

export interface BackfillResult {
  pendingRules: number
  skippedSelfReapplying: number[]
  candidateEpisodes: number
  changedEpisodes: number
  reembeddedEpisodes: number
  /** Per rule: episodes whose text it changed. */
  changesByRule: Record<number, number>
  /** Rules stamped backfilled_at this run. */
  stampedRules: number[]
}

const PAGE = 500

/** Episode ids (this station, in the rule's scope) whose stored transcript
 *  might match the rule — a Postgres-regex superset when one can be built. */
async function candidateEpisodeIds(
  client: SupabaseClient,
  stationId: string,
  rule: StoredCorrection,
  keysInScope: string[] | null,
): Promise<number[]> {
  if (rule.episodeId != null) return [rule.episodeId]
  const pattern = toPrefilterPattern(rule)
  const run = async (usePattern: boolean) => {
    const ids: number[] = []
    for (let from = 0; ; from += PAGE) {
      let q = client
        .from('transcripts')
        .select('episode_id, episode_log!inner(station_id, show_key)')
        .eq('episode_log.station_id', stationId)
        .order('episode_id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (keysInScope) q = q.in('episode_log.show_key', keysInScope)
      if (usePattern && pattern) q = q.filter('transcript', rule.caseSensitive ? 'match' : 'imatch', pattern)
      const { data, error } = await q
      if (error) throw new Error(error.message)
      for (const row of data ?? []) ids.push(row.episode_id as number)
      if (!data || data.length < PAGE) break
    }
    return ids
  }
  try {
    return await run(true)
  } catch (err) {
    // Postgres rejected the translated pattern — fall back to scanning scope.
    if (!pattern) throw err
    console.warn(`[corrections] prefilter failed for rule ${rule.id}, scanning scope:`, err instanceof Error ? err.message : err)
    return run(false)
  }
}

export async function backfillPendingCorrections(
  client: SupabaseClient,
  stationId: string,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const result: BackfillResult = {
    pendingRules: 0,
    skippedSelfReapplying: [],
    candidateEpisodes: 0,
    changedEpisodes: 0,
    reembeddedEpisodes: 0,
    changesByRule: {},
    stampedRules: [],
  }

  const all = await loadCorrectionRules(client, stationId)
  let pending = all.filter((r) => r.backfilledAt == null)
  if (opts.ruleIds) pending = pending.filter((r) => opts.ruleIds!.includes(r.id))
  result.pendingRules = pending.length
  if (!pending.length) return result

  // A rule that changes its own output again would grow on every re-run. It
  // stays pending (never stamped as applied) and is reported, not re-applied.
  const safe = pending.filter((r) => {
    if (!isSelfReapplying(r)) return true
    result.skippedSelfReapplying.push(r.id)
    return false
  })

  const { groupOf, keysInGroup } = await loadShowGroups(client, stationId)

  // episode → the pending rules that might change it
  const byEpisode = new Map<number, Set<number>>()
  for (const rule of safe) {
    const keys = rule.showKey ? keysInGroup(rule.showKey) : null
    for (const id of await candidateEpisodeIds(client, stationId, rule, keys)) {
      byEpisode.set(id, (byEpisode.get(id) ?? new Set()).add(rule.id))
    }
  }
  result.candidateEpisodes = byEpisode.size

  const embeddingsOn = opts.apply ? await isEmbeddingsEnabled(stationId) : false
  const embeddingModel = embeddingsOn ? await getEmbeddingModel(stationId) : ''
  // One pass over every candidate (one transcript in memory at a time), so a
  // loose prefilter costs reads once instead of stalling a capped loop.
  for (const [episodeId, ruleIds] of Array.from(byEpisode)) {
    const { data: row, error } = await client
      .from('transcripts')
      .select('transcript, vtt, episode_log!inner(station_id, show_key)')
      .eq('episode_id', episodeId)
      .eq('episode_log.station_id', stationId)
      .maybeSingle()
    if (error) throw new Error(`episode ${episodeId}: ${error.message}`)
    if (!row) continue
    const ep = row.episode_log as unknown as { show_key: string | null }

    // Original creation order, re-checked against the episode's actual scope.
    const candidates = safe.filter((r) => ruleIds.has(r.id))
    const rules = correctionsForEpisode(candidates, episodeId, ep.show_key, groupOf)
    if (!rules.length) continue

    const before = row.transcript ?? ''
    const after = applyCorrections(before, rules)
    const vttAfter = row.vtt ? applyCorrectionsToVtt(row.vtt, rules) : row.vtt
    if (after === before && vttAfter === row.vtt) continue

    for (const r of rules) {
      if (applyCorrections(before, [r]) !== before || (row.vtt && applyCorrectionsToVtt(row.vtt, [r]) !== row.vtt)) {
        result.changesByRule[r.id] = (result.changesByRule[r.id] ?? 0) + 1
      }
    }
    result.changedEpisodes++
    if (!opts.apply) continue

    const { error: upError } = await client
      .from('transcripts')
      .update({ transcript: after, vtt: vttAfter })
      .eq('episode_id', episodeId)
    if (upError) throw new Error(`episode ${episodeId}: ${upError.message}`)
    // Captions changed: move the episode in the public feed's updated_since
    // delta (/api/v1/episodes) so caption consumers re-pull them.
    await client
      .from('episode_log')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', episodeId)
      .eq('station_id', stationId)

    // Search surfaces derived from the text. Best-effort: the transcript itself
    // is already fixed, and a rebuild can be re-run.
    try {
      await replaceEpisodeCues(client, episodeId, vttAfter)
    } catch (err) {
      console.warn(`[corrections] ep ${episodeId} cue rebuild failed:`, err instanceof Error ? err.message : err)
    }
    if (embeddingsOn && vttAfter) {
      try {
        const { count } = await client
          .from('transcript_chunks')
          .select('episode_id', { count: 'exact', head: true })
          .eq('episode_id', episodeId)
        // Only refresh episodes that were embedded; the summarize worker embeds the rest.
        if ((count ?? 0) > 0) {
          const { rows, tokens } = await buildEpisodeChunkRows(vttAfter, embeddingModel)
          await storeEpisodeChunks(client, episodeId, rows)
          if (tokens > 0) await logEmbeddingUsage(stationId, episodeId, tokens, embeddingModel)
          result.reembeddedEpisodes++
        }
      } catch (err) {
        console.warn(`[corrections] ep ${episodeId} re-embed failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  if (opts.apply && result.changedEpisodes > 0) {
    void bumpCacheVersion(stationId, 'transcripts')
    void bumpCacheVersion(stationId, 'episodes')
  }

  // Stamp rules fully processed this run — only if unchanged since we loaded
  // them (an edit mid-run clears backfilled_at and must be picked up again).
  if (opts.apply) {
    for (const rule of safe) {
      let q = client
        .from('transcript_corrections')
        .update({ backfilled_at: new Date().toISOString() })
        .eq('id', rule.id)
        .eq('station_id', stationId)
        .eq('wrong', rule.wrong)
        .eq('correct', rule.correct)
        .eq('is_regex', rule.isRegex)
        .eq('case_sensitive', rule.caseSensitive)
        .is('backfilled_at', null)
      q = rule.showKey ? q.eq('show_key', rule.showKey) : q.is('show_key', null)
      q = rule.episodeId != null ? q.eq('episode_id', rule.episodeId) : q.is('episode_id', null)
      const { error } = await q
      if (error) console.warn(`[corrections] could not stamp rule ${rule.id}:`, error.message)
      else result.stampedRules.push(rule.id)
    }
  }

  return result
}
