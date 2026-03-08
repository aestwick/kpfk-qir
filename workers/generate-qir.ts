import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logCurationUsage } from '../lib/usage'
import { getSetting } from '../lib/settings'
import {
  episodeToQirEntry,
  formatFullReport,
  formatCuratedReport,
  getQuarterDateRange,
  type QirEntry,
} from '../lib/qir-format'

const CURATION_SYSTEM_PROMPT = `You are an expert public radio producer helping select the most significant programming entries for an FCC Quarterly Issues Report.

You will receive a list of radio program entries grouped by issue category. For each category, select up to the specified maximum number of entries that best demonstrate community service.

SELECTION CRITERIA (in order of priority):
1. Variety of shows — avoid picking many entries from the same show
2. Substantive content — clear topics, identified guests, meaningful descriptions
3. Date range — spread across the quarter, not clustered in one period
4. EXCLUDE: pledge drives, promotions, entertainment without clear community issue connection

OUTPUT: Return ONLY valid JSON. No markdown, no extra text.
Return an object where keys are category names and values are arrays of episode IDs that should be included.
Example: {"Civil Rights / Social Justice": [123, 456, 789], "Health": [101, 202]}`

export async function processGenerateQir(job: Job) {
  const { year, quarter } = job.data as { year: number; quarter: number }
  console.log(`[generate-qir] starting Q${quarter} ${year}...`)

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set')

  const openai = new OpenAI({ apiKey: openaiKey })
  const { start, end } = getQuarterDateRange(year, quarter)

  const maxPerCategory =
    (await getSetting<number>('max_entries_per_category')) ?? 12
  const issueCategories =
    (await getSetting<string[]>('issue_categories')) ?? [
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
    .in('status', ['summarized', 'compliance_checked'])
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('air_date', { ascending: true })

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!episodes?.length) {
    console.log('[generate-qir] no completed episodes for this quarter')
    return { drafted: false, reason: 'no episodes' }
  }

  // Convert to QIR entries
  const allEntries = episodes.map(episodeToQirEntry)

  // Group by category
  const grouped: Record<string, QirEntry[]> = {}
  for (const entry of allEntries) {
    const cat = entry.issue_category || 'Uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(entry)
  }

  // Build the full report text
  const fullText = formatFullReport(allEntries, year, quarter)

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

  const userMessage = `Select up to ${maxPerCategory} entries per category for the FCC Quarterly Issues Report.
Available categories: ${issueCategories.join(', ')}

${categorySummaries.join('\n')}`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: CURATION_SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  })

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('Empty response from OpenAI')

  let curatedSelection: Record<string, number[]>
  try {
    curatedSelection = JSON.parse(content)
  } catch {
    throw new Error(`Invalid JSON from OpenAI: ${content.slice(0, 200)}`)
  }

  if (typeof curatedSelection !== 'object' || curatedSelection === null || Object.keys(curatedSelection).length === 0) {
    throw new Error(`OpenAI returned empty or invalid curation selection: ${content.slice(0, 200)}`)
  }

  // Collect curated episode IDs
  const curatedIds = new Set<number>()
  for (const ids of Object.values(curatedSelection)) {
    if (Array.isArray(ids)) {
      for (const id of ids) curatedIds.add(id)
    }
  }

  // Build curated entries list
  const curatedEntries = allEntries.filter((e) => curatedIds.has(e.episode_id))
  const curatedText = formatCuratedReport(curatedEntries, year, quarter)

  // Get the next version number for this quarter
  const { data: existingDrafts } = await supabaseAdmin
    .from('qir_drafts')
    .select('version')
    .eq('year', year)
    .eq('quarter', quarter)
    .order('version', { ascending: false })
    .limit(1)

  const nextVersion = (existingDrafts?.[0]?.version ?? 0) + 1

  // Store the draft
  const { data: draft, error: insertErr } = await supabaseAdmin
    .from('qir_drafts')
    .insert({
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
    await logCurationUsage(usage.prompt_tokens, usage.completion_tokens, {
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

  return {
    drafted: true,
    draft_id: draft?.id,
    version: nextVersion,
    total_episodes: allEntries.length,
    curated_episodes: curatedEntries.length,
  }
}
