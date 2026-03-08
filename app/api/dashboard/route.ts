import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'

export const dynamic = 'force-dynamic'

function getQuarterBounds() {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const year = now.getFullYear()
  const quarter = q + 1
  const start = new Date(year, q * 3, 1).toISOString().slice(0, 10)
  const end = new Date(year, q * 3 + 3, 0).toISOString().slice(0, 10)
  return { year, quarter, start, end, label: `Q${quarter} ${year}` }
}

async function getQueueCounts(queue: typeof ingestQueue) {
  const counts = await queue.getJobCounts()
  return {
    active: counts.active ?? 0,
    waiting: counts.waiting ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
  }
}

export async function GET() {
  const qtr = getQuarterBounds()

  const [
    statusCounts,
    qtrStatusCounts,
    recentEpisodes,
    recentActivity,
    usageThisQuarter,
    dailyCosts,
    categoryBreakdown,
    showBreakdown,
    ingestCounts,
    transcribeCounts,
    summarizeCounts,
    complianceCounts,
    processingTimes,
    activeShows,
    complianceFlags,
    qirDrafts,
    monthlyUsage,
  ] = await Promise.all([
    // 1. Overall status counts
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabaseAdmin
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('status', s)
        return [s, count ?? 0] as const
      })
    ),

    // 2. Quarter-specific status counts
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabaseAdmin
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('status', s)
          .gte('air_date', qtr.start)
          .lte('air_date', qtr.end)
        return [s, count ?? 0] as const
      })
    ),

    // 3. Recently updated episodes
    supabaseAdmin
      .from('episode_log')
      .select('id, show_name, headline, status, updated_at, air_date, issue_category')
      .order('updated_at', { ascending: false })
      .limit(15),

    // 4. Recently processed (24h)
    supabaseAdmin
      .from('episode_log')
      .select('id, show_name, status, updated_at, headline')
      .gte('updated_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('updated_at', { ascending: false })
      .limit(50),

    // 5. Usage/cost for this quarter
    supabaseAdmin
      .from('usage_log')
      .select('*')
      .gte('created_at', qtr.start)
      .lte('created_at', qtr.end + 'T23:59:59'),

    // 6. Daily costs for last 30 days
    supabaseAdmin
      .from('usage_log')
      .select('created_at, estimated_cost, service, operation')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true }),

    // 7. Issue category distribution (completed episodes this quarter)
    supabaseAdmin
      .from('episode_log')
      .select('issue_category')
      .in('status', ['summarized', 'compliance_checked'])
      .gte('air_date', qtr.start)
      .lte('air_date', qtr.end),

    // 8. Show distribution (this quarter)
    supabaseAdmin
      .from('episode_log')
      .select('show_name, show_key, status')
      .gte('air_date', qtr.start)
      .lte('air_date', qtr.end),

    // 9-12. Queue status
    getQueueCounts(ingestQueue),
    getQueueCounts(transcribeQueue),
    getQueueCounts(summarizeQueue),
    getQueueCounts(complianceQueue),

    // 13. Processing times (last 7 days)
    supabaseAdmin
      .from('usage_log')
      .select('operation, duration_seconds, estimated_cost, created_at')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .not('duration_seconds', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200),

    // 14. Active shows (for coverage gaps)
    supabaseAdmin
      .from('show_keys')
      .select('key, show_name, category, active')
      .eq('active', true),

    // 15. Unresolved compliance flags
    supabaseAdmin
      .from('compliance_flags')
      .select('flag_type, severity')
      .eq('resolved', false),

    // 16. QIR drafts for current quarter
    supabaseAdmin
      .from('qir_drafts')
      .select('id, status, version, curated_entries')
      .eq('year', qtr.year)
      .eq('quarter', qtr.quarter)
      .order('version', { ascending: false })
      .limit(1),

    // 17. Current month usage
    supabaseAdmin
      .from('usage_log')
      .select('estimated_cost, service')
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),
  ])

  // Aggregate status counts
  const allCounts = Object.fromEntries(statusCounts)
  const quarterCounts = Object.fromEntries(qtrStatusCounts)

  // Aggregate usage/cost
  const usage = { groq: 0, openai: 0, total: 0, episodes: new Set<number>(), apiCalls: 0 }
  for (const row of usageThisQuarter.data ?? []) {
    const cost = Number(row.estimated_cost) || 0
    usage.total += cost
    if (row.service === 'groq') usage.groq += cost
    if (row.service === 'openai') usage.openai += cost
    if (row.episode_id) usage.episodes.add(row.episode_id)
    usage.apiCalls++
  }

  // Daily cost aggregation
  const dailyMap = new Map<string, { groq: number; openai: number }>()
  for (const row of dailyCosts.data ?? []) {
    const day = row.created_at.slice(0, 10)
    const entry = dailyMap.get(day) ?? { groq: 0, openai: 0 }
    const cost = Number(row.estimated_cost) || 0
    if (row.service === 'groq') entry.groq += cost
    else entry.openai += cost
    dailyMap.set(day, entry)
  }
  const dailyCostData = Array.from(dailyMap.entries())
    .map(([date, costs]) => ({ date, groq: costs.groq, openai: costs.openai, total: costs.groq + costs.openai }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Category distribution
  const categories = new Map<string, number>()
  for (const row of categoryBreakdown.data ?? []) {
    const cat = row.issue_category ?? 'Uncategorized'
    categories.set(cat, (categories.get(cat) ?? 0) + 1)
  }
  const categoryData = Array.from(categories.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)

  // Show distribution
  const shows = new Map<string, { total: number; summarized: number }>()
  for (const row of showBreakdown.data ?? []) {
    const name = row.show_name ?? 'Unknown'
    const entry = shows.get(name) ?? { total: 0, summarized: 0 }
    entry.total++
    if (row.status === 'summarized' || row.status === 'compliance_checked') entry.summarized++
    shows.set(name, entry)
  }
  const showData = Array.from(shows.entries())
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)

  // Activity timeline
  const activityData = (recentActivity.data ?? []).map((ep) => ({
    id: ep.id,
    show_name: ep.show_name,
    headline: ep.headline,
    status: ep.status,
    time: ep.updated_at,
  }))

  // Processing time averages
  const procTimes: Record<string, { total: number; count: number }> = {}
  for (const row of processingTimes.data ?? []) {
    const op = row.operation
    if (!procTimes[op]) procTimes[op] = { total: 0, count: 0 }
    procTimes[op].total += Number(row.duration_seconds) || 0
    procTimes[op].count++
  }
  const avgProcessingTimes = Object.fromEntries(
    Object.entries(procTimes).map(([op, data]) => [op, data.count > 0 ? data.total / data.count : 0])
  )

  // Coverage gaps
  const excludedShowCategories = ['Music', 'Español']
  const activeShowsList = (activeShows.data ?? []).filter(
    (s) => !excludedShowCategories.some((exc) => s.category?.includes(exc))
  )
  const showsWithEpisodes = new Set(
    (showBreakdown.data ?? [])
      .filter((ep) => ep.status === 'summarized' || ep.status === 'compliance_checked')
      .map((ep) => ep.show_key)
  )
  const coverageGaps = activeShowsList
    .filter((s) => !showsWithEpisodes.has(s.key))
    .map((s) => s.show_name)
    .sort()

  // QIR readiness
  const coveredCategories = new Set(
    (categoryBreakdown.data ?? [])
      .map((r) => r.issue_category)
      .filter(Boolean)
  )
  const allIssueCategories = [
    'Civil Rights / Social Justice', 'Immigration', 'Economy / Labor',
    'Environment / Climate', 'Government / Politics', 'Health',
    'International Affairs / War & Peace', 'Arts & Culture',
  ]

  // Compliance summary
  const complianceFlagCounts: Record<string, { count: number; critical: number }> = {}
  for (const flag of complianceFlags.data ?? []) {
    if (!complianceFlagCounts[flag.flag_type]) {
      complianceFlagCounts[flag.flag_type] = { count: 0, critical: 0 }
    }
    complianceFlagCounts[flag.flag_type].count++
    if (flag.severity === 'critical') complianceFlagCounts[flag.flag_type].critical++
  }

  // QIR status
  const latestDraft = qirDrafts.data?.[0] ?? null
  const qirStatus = latestDraft
    ? { status: latestDraft.status, version: latestDraft.version, entryCount: (latestDraft.curated_entries as unknown[])?.length ?? 0 }
    : null

  // Monthly cost
  let monthGroq = 0, monthOpenai = 0
  for (const row of monthlyUsage.data ?? []) {
    const cost = Number(row.estimated_cost) || 0
    if (row.service === 'groq') monthGroq += cost
    else monthOpenai += cost
  }

  // Time estimates
  const pendingCount = quarterCounts.pending ?? 0
  const transcribedCount = quarterCounts.transcribed ?? 0
  const summarizedCount = quarterCounts.summarized ?? 0
  const avgTranscribe = avgProcessingTimes.transcribe ?? 180
  const avgSummarize = avgProcessingTimes.summarize ?? 15

  const timeEstimates = {
    transcription: pendingCount > 0 ? { count: pendingCount, avgSeconds: avgTranscribe, totalMinutes: Math.ceil((pendingCount * avgTranscribe) / 60) } : null,
    summarization: transcribedCount > 0 ? { count: transcribedCount, avgSeconds: avgSummarize, totalMinutes: Math.ceil((transcribedCount * avgSummarize) / 60) } : null,
    compliance: summarizedCount > 0 ? { count: summarizedCount, totalMinutes: Math.ceil(summarizedCount * 0.5) } : null,
  }

  return NextResponse.json({
    quarter: qtr,
    counts: {
      all: allCounts,
      quarter: quarterCounts,
    },
    queues: {
      ingest: ingestCounts,
      transcribe: transcribeCounts,
      summarize: summarizeCounts,
      compliance: complianceCounts,
    },
    cost: {
      quarter: { groq: usage.groq, openai: usage.openai, total: usage.total, episodeCount: usage.episodes.size, apiCalls: usage.apiCalls },
      daily: dailyCostData,
      month: { groq: monthGroq, openai: monthOpenai, total: monthGroq + monthOpenai },
    },
    categories: categoryData,
    shows: showData,
    recentEpisodes: (recentEpisodes.data ?? []).slice(0, 15),
    activity24h: activityData,
    avgProcessingTimes,
    timeEstimates,
    qirReadiness: {
      coveredCategories: Array.from(coveredCategories),
      totalCategories: allIssueCategories.length,
      missingCategories: allIssueCategories.filter(c => !coveredCategories.has(c)),
    },
    coverageGaps,
    complianceSummary: complianceFlagCounts,
    qirStatus,
  })
}
