import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logCurationUsage } from '../lib/usage'
import { getSetting, getCurationPrompt, getCurationModel, isComplianceBlocking } from '../lib/settings'
import { getStation } from '../lib/stations'
import { resolveGroupDisplayName, showGroupKey } from '../lib/shows'
import {
  episodeToQirEntry,
  formatFullReport,
  formatCuratedReport,
  getQuarterDateRange,
  type QirEntry,
} from '../lib/qir-format'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'

export interface GenerateQirOptions {
  year: number
  quarter: number
  /** Station this draft belongs to — scopes episodes and the stored draft. */
  stationId: string
  /** If provided, only include episodes from these show_keys */
  includedShows?: string[]
  /** Custom guidance text appended to the AI curation prompt */
  guidance?: string
}

export async function processGenerateQir(job: Job) {
  const { year, quarter, stationId, includedShows, guidance } = job.data as GenerateQirOptions
  if (!stationId) throw new Error('stationId is required to generate a QIR draft')
  const station = await getStation(stationId)
  if (!station) throw new Error(`[generate-qir] station ${stationId} not found`)
  console.log(`[generate-qir] starting Q${quarter} ${year} for ${station.slug}...`)
  if (includedShows?.length) console.log(`[generate-qir] filtering to ${includedShows.length} shows`)
  if (guidance) console.log(`[generate-qir] custom guidance provided`)

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set')

  const openai = new OpenAI({ apiKey: openaiKey })
  const { start, end } = getQuarterDateRange(year, quarter)

  const curationSystemPrompt = await getCurationPrompt(stationId)
  const curationModel = await getCurationModel(stationId)
  const maxPerCategory =
    (await getSetting<number>('max_entries_per_category', stationId)) ?? 12
  const issueCategories =
    (await getSetting<string[]>('issue_categories', stationId)) ?? [
      'Civil Rights / Social Justice',
      'Immigration',
      'Economy / Labor',
      'Environment / Climate',
      'Government / Politics',
      'Health',
      'International Affairs / War & Peace',
      'Arts & Culture',
    ]

  // Get all completed episodes in this quarter (summarized or compliance_checked),
  // including those with null air_date created during this quarter
  const { data: episodes, error } = await supabaseAdmin
    .from('episode_log')
    .select('*')
    .eq('station_id', stationId)
    .in('status', ['summarized', 'compliance_checked'])
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('air_date', { ascending: true })

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!episodes?.length) {
    console.log('[generate-qir] no completed episodes for this quarter')
    return { drafted: false, reason: 'no episodes' }
  }

  // Compliance blocking gate (centralized, FCC safety). When on, hold back any
  // episode that has an unresolved CRITICAL flag — only a 'dismissed' (cleared)
  // critical flag lets it into the report. Warnings never block.
  let blockedCount = 0
  let gatedEpisodes = episodes
  if (await isComplianceBlocking()) {
    const { data: criticalFlags } = await supabaseAdmin
      .from('compliance_flags')
      .select('episode_id')
      .in('episode_id', episodes.map((e) => e.id))
      .eq('severity', 'critical')
      .neq('review_status', 'dismissed')
    const blocked = new Set((criticalFlags ?? []).map((f) => f.episode_id))
    if (blocked.size) {
      blockedCount = blocked.size
      gatedEpisodes = episodes.filter((e) => !blocked.has(e.id))
      console.log(`[generate-qir] blocking on — held back ${blockedCount} episode(s) with unresolved critical flags`)
    }
  }
  if (!gatedEpisodes.length) {
    console.log('[generate-qir] all candidate episodes blocked by unresolved critical flags')
    return { drafted: false, reason: 'all episodes blocked by compliance', blocked: blockedCount }
  }

  // Filter by included shows if specified
  const filteredEpisodes = includedShows?.length
    ? gatedEpisodes.filter(ep => includedShows.includes(ep.show_key))
    : gatedEpisodes

  if (!filteredEpisodes.length) {
    console.log('[generate-qir] no episodes match show filter')
    return { drafted: false, reason: 'no episodes match filter' }
  }

  // Resolve a single display name per logical show (group) so sibling feeds —
  // which can carry different name spellings — appear under one consistent name
  // in the report (the episode's show_name is a possibly-stale ingest snapshot).
  // Display-only; grouping/merging happens via the explicit show_group.
  const { data: showKeyRows } = await supabaseAdmin
    .from('show_keys')
    .select('key, show_name, feed_name, display_name, show_group')
    .eq('station_id', stationId)
  // Case-insensitive merge key so feeds whose group labels differ only by
  // capitalization still resolve to one logical show (showGroupKey).
  const feedsByGroup = new Map<string, typeof showKeyRows>()
  for (const r of showKeyRows ?? []) {
    const group = showGroupKey(r)
    const list = feedsByGroup.get(group) ?? []
    list.push(r)
    feedsByGroup.set(group, list)
  }
  const stripPrefixes = station.show_name_strip_prefixes ?? null
  const displayNameByKey = new Map<string, string>()
  for (const r of showKeyRows ?? []) {
    const group = showGroupKey(r)
    displayNameByKey.set(r.key, resolveGroupDisplayName(feedsByGroup.get(group) ?? [r], stripPrefixes))
  }

  // Convert to QIR entries, overriding the snapshot name with the resolved one.
  const allEntries = filteredEpisodes.map((ep) => {
    const entry = episodeToQirEntry(ep)
    const resolved = ep.show_key ? displayNameByKey.get(ep.show_key) : undefined
    return resolved ? { ...entry, show_name: resolved } : entry
  })

  // Group by category
  const grouped: Record<string, QirEntry[]> = {}
  for (const entry of allEntries) {
    const cat = entry.issue_category || 'Uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(entry)
  }

  // Build the full report text
  const fullText = formatFullReport(allEntries, year, quarter, station.name)

  // Build prompt for AI curation
  const categorySummaries: string[] = []
  for (const [category, entries] of Object.entries(grouped)) {
    const entrySummaries = entries.map(
      (e) =>
        `  ID:${e.episode_id} | ${e.show_name} | ${e.air_date} | "${e.headline}" | Guest: ${e.guest || 'none'} | ${e.summary.slice(0, 200)}`
    )
    categorySummaries.push(
      `\n## ${category} (${entries.length} entries)\n${entrySummaries.join('\n')}`
    )
  }

  const guidanceSection = guidance
    ? `\n\nADDITIONAL GUIDANCE FROM THE EDITOR:\n${guidance}\n`
    : ''

  const userMessage = `Select up to ${maxPerCategory} entries per category for the FCC Quarterly Issues Report.
Available categories: ${issueCategories.join(', ')}
${guidanceSection}
${categorySummaries.join('\n')}`

  const response = await openai.chat.completions.create({
    model: curationModel,
    messages: [
      { role: 'system', content: curationSystemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  })

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('Empty response from OpenAI')

  let curatedSelection: Record<string, unknown[]>
  try {
    curatedSelection = JSON.parse(content)
  } catch {
    throw new Error(`Invalid JSON from OpenAI: ${content.slice(0, 200)}`)
  }

  if (typeof curatedSelection !== 'object' || curatedSelection === null || Object.keys(curatedSelection).length === 0) {
    throw new Error(`OpenAI returned empty or invalid curation selection: ${content.slice(0, 200)}`)
  }

  // Collect selected episode IDs + capture the model's filing-ready rewrite. The
  // curation prompt returns, per category, an array of { id, topic, description }
  // objects (it both SELECTS and rewrites each entry). Accept a bare-number shape
  // too, so a prompt/parser mismatch degrades to selection-only instead of silently
  // yielding zero entries — which is exactly what the number[]-only parser did once
  // the prompt was switched to rich objects (it added objects to a Set<number>).
  const curatedIds = new Set<number>()
  const rewriteById = new Map<number, { topic?: string; description?: string }>()
  for (const items of Object.values(curatedSelection)) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (typeof item === 'number') {
        curatedIds.add(item)
      } else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'number') {
        const it = item as { id: number; topic?: string; description?: string }
        curatedIds.add(it.id)
        rewriteById.set(it.id, { topic: it.topic, description: it.description })
      }
    }
  }

  // Fail loudly rather than store a useless 0-entry draft (the old silent failure).
  if (curatedIds.size === 0) {
    throw new Error(`OpenAI curation selected no valid episode IDs: ${content.slice(0, 200)}`)
  }

  // Build curated entries list, applying the model's filing-ready rewrite
  // (topic → headline, description → summary) when present.
  const curatedEntries = allEntries
    .filter((e) => curatedIds.has(e.episode_id))
    .map((e) => {
      const rw = rewriteById.get(e.episode_id)
      if (!rw) return e
      return {
        ...e,
        headline: rw.topic?.trim() || e.headline,
        summary: rw.description?.trim() || e.summary,
      }
    })
  const curatedText = formatCuratedReport(curatedEntries, year, quarter, station.name)

  // Get the next version number for this quarter
  const { data: existingDrafts } = await supabaseAdmin
    .from('qir_drafts')
    .select('version')
    .eq('station_id', stationId)
    .eq('year', year)
    .eq('quarter', quarter)
    .order('version', { ascending: false })
    .limit(1)

  const nextVersion = (existingDrafts?.[0]?.version ?? 0) + 1

  // Store the draft. station_id is NOT NULL and has no default — every reader
  // scopes by it (and RLS depends on it), so the draft is tenant-owned. Omitting
  // it fails the insert with a not-null violation after all curation work is done.
  const { data: draft, error: insertErr } = await supabaseAdmin
    .from('qir_drafts')
    .insert({
      station_id: stationId,
      year,
      quarter,
      status: 'draft',
      curated_entries: curatedEntries.map((e) => ({
        episode_id: e.episode_id,
        show_name: e.show_name,
        host: e.host,
        air_date: e.air_date,
        start_time: e.start_time,
        duration: e.duration,
        headline: e.headline,
        guest: e.guest,
        summary: e.summary,
        issue_category: e.issue_category,
      })),
      settings_snapshot: {
        max_entries_per_category: maxPerCategory,
        issue_categories: issueCategories,
        included_shows: includedShows ?? null,
        guidance: guidance ?? null,
      },
      full_text: fullText,
      curated_text: curatedText,
      version: nextVersion,
    })
    .select()
    .single()

  if (insertErr) throw new Error(`Failed to store draft: ${insertErr.message}`)

  // Log usage
  const usage = response.usage
  if (usage) {
    await logCurationUsage(stationId, usage.prompt_tokens, usage.completion_tokens, curationModel, {
      year,
      quarter,
      draft_id: draft?.id,
      episodes_considered: allEntries.length,
      episodes_curated: curatedEntries.length,
    })
  }

  console.log(
    `[generate-qir] Q${quarter} ${year} draft v${nextVersion} created — ${curatedEntries.length} curated from ${allEntries.length} total`
  )

  void logAuditEvent({
    action: AUDIT_ACTIONS.QIR_GENERATE_COMPLETE,
    operation: 'insert',
    stationId,
    resourceType: 'qir_draft',
    resourceId: draft?.id,
    metadata: {
      year,
      quarter,
      version: nextVersion,
      totalEpisodes: allEntries.length,
      curatedEpisodes: curatedEntries.length,
    },
  })

  return {
    drafted: true,
    draft_id: draft?.id,
    version: nextVersion,
    total_episodes: allEntries.length,
    curated_episodes: curatedEntries.length,
    blocked_episodes: blockedCount,
  }
}
