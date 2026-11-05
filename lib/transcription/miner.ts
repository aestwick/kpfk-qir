// Nightly name upkeep for one station (service-role; station_id-filtered):
//   1. syncCmsHosts — copy new website (CMS) hosts into the show's name list, so
//      a host added on kpfk.org flows into transcription with no extra step.
//   2. mineSuggestions — find recurring misspellings of known names in the
//      show's recent transcripts and queue them for a person to approve.
// Neither rewrites a transcript: approval in Settings → Corrections does.

import type { SupabaseClient } from '@supabase/supabase-js'
import { correctionsForEpisode } from './corrections'
import { loadCorrectionRules, loadShowGroups } from './store'
import { filterMinedVariants, snippetAround, type MinedVariant } from './suggestions'

/** "Arnella Barbara (Dark Star Gurl)" → "Arnella Barbara"; drops group entries
 *  ("Contributors & Community Reporters") and one-word handles the hint can't use. */
export function cleanCmsHostName(raw: string | null | undefined): string | null {
  const name = (raw ?? '').replace(/\([^)]*\)/g, ' ').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim()
  if (name.length < 2 || name.length > 60) return null
  if (/&|\band\b|\d/i.test(name)) return null
  return name
}

/** Copy CMS hosts into transcript_vocabulary (source 'cms'). Never re-adds a
 *  name that exists for the show in ANY state — switching a name off sticks. */
export async function syncCmsHosts(client: SupabaseClient, stationId: string): Promise<number> {
  const [{ data: hosts, error: hErr }, { data: sources, error: sErr }, { data: keys, error: kErr }] = await Promise.all([
    client.from('cms_show_hosts').select('name, show_id, cms_shows!inner(id, station_id, program_slug, deleted_at)').eq('cms_shows.station_id', stationId),
    client.from('cms_show_source').select('cms_show_id, qir_show_key').eq('station_id', stationId),
    client.from('show_keys').select('key').eq('station_id', stationId),
  ])
  // The CMS tables belong to the website app; if they aren't there, skip quietly.
  if (hErr || sErr || kErr) {
    console.warn('[corrections] CMS host sync skipped:', (hErr ?? sErr ?? kErr)?.message)
    return 0
  }
  const known = new Set((keys ?? []).map((k) => k.key))
  const keysByShow = new Map<string, Set<string>>()
  for (const s of sources ?? []) {
    if (!s.cms_show_id || !s.qir_show_key || !known.has(s.qir_show_key)) continue
    keysByShow.set(s.cms_show_id, (keysByShow.get(s.cms_show_id) ?? new Set()).add(s.qir_show_key))
  }

  const wanted: Array<{ show_key: string; name: string }> = []
  for (const h of hosts ?? []) {
    const show = h.cms_shows as unknown as { id: string; program_slug: string | null; deleted_at: string | null }
    if (show.deleted_at) continue
    const name = cleanCmsHostName(h.name)
    if (!name) continue
    const showKeys = new Set(keysByShow.get(show.id) ?? [])
    // Same fallback verify-week uses: a CMS show whose slug IS the show key.
    if (!showKeys.size && show.program_slug && known.has(show.program_slug)) showKeys.add(show.program_slug)
    for (const key of Array.from(showKeys)) wanted.push({ show_key: key, name })
  }
  if (!wanted.length) return 0

  const { data: existing, error: eErr } = await client
    .from('transcript_vocabulary')
    .select('show_key, name')
    .eq('station_id', stationId)
  if (eErr) throw new Error(eErr.message)
  const have = new Set((existing ?? []).map((v) => `${v.show_key ?? ''}|${v.name.toLowerCase()}`))
  const toInsert = wanted.filter((w) => {
    const k = `${w.show_key}|${w.name.toLowerCase()}`
    if (have.has(k)) return false
    have.add(k)
    return true
  })
  if (!toInsert.length) return 0
  const { error } = await client
    .from('transcript_vocabulary')
    .insert(toInsert.map((w) => ({ station_id: stationId, show_key: w.show_key, name: w.name, source: 'cms' })))
  if (error) throw new Error(error.message)
  return toInsert.length
}

export interface MineResult {
  candidates: number
  queued: number
  updated: number
}

/** Run the database miner over the last `sinceDays` and upsert suggestions.
 *  Suggestions already approved or rejected are left alone. */
export async function mineSuggestions(
  client: SupabaseClient,
  stationId: string,
  sinceDays = 60,
): Promise<MineResult> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10)
  const { data: raw, error } = await client.rpc('mine_name_variants', {
    p_station_id: stationId,
    p_since: since,
  })
  if (error) throw new Error(`mine_name_variants: ${error.message}`)

  const [{ data: vocab }, rules, groups, { data: existing }] = await Promise.all([
    client.from('transcript_vocabulary').select('name').eq('station_id', stationId),
    loadCorrectionRules(client, stationId),
    loadShowGroups(client, stationId),
    client.from('transcript_correction_suggestions').select('id, show_key, variant, correct, status').eq('station_id', stationId),
  ])
  const rows = filterMinedVariants((raw ?? []) as MinedVariant[], {
    knownNames: new Set((vocab ?? []).map((v) => v.name.trim().toLowerCase())),
    rulesForShow: (key) => correctionsForEpisode(rules, -1, key, groups.groupOf),
  })

  const keyOf = (showKey: string | null, variant: string, correct: string) =>
    `${showKey ?? ''}|${variant.toLowerCase()}|${correct.toLowerCase()}`
  const byKey = new Map((existing ?? []).map((s) => [keyOf(s.show_key, s.variant, s.correct), s]))

  const result: MineResult = { candidates: rows.length, queued: 0, updated: 0 }
  const now = new Date().toISOString()
  for (const r of rows) {
    const prior = byKey.get(keyOf(r.show_key, r.variant, r.name))
    if (prior && prior.status !== 'suggested') continue

    let sample: string | null = null
    if (r.sample_episode_id) {
      const { data: t } = await client
        .from('transcripts')
        .select('transcript, episode_log!inner(station_id)')
        .eq('episode_id', r.sample_episode_id)
        .eq('episode_log.station_id', stationId)
        .maybeSingle()
      if (t?.transcript) sample = snippetAround(t.transcript, r.variant)
    }
    const fields = {
      occurrences: r.occurrences,
      episodes: r.episodes,
      sample_episode_id: r.sample_episode_id,
      sample_text: sample,
      last_seen_at: now,
    }
    if (prior) {
      const { error: uErr } = await client.from('transcript_correction_suggestions').update(fields).eq('id', prior.id)
      if (uErr) throw new Error(uErr.message)
      result.updated++
    } else {
      const { error: iErr } = await client.from('transcript_correction_suggestions').insert({
        station_id: stationId,
        show_key: r.show_key,
        variant: r.variant,
        correct: r.name,
        ...fields,
      })
      if (iErr) throw new Error(iErr.message)
      result.queued++
    }
  }
  return result
}
