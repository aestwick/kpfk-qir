import { NextResponse } from 'next/server'
import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { getIssueCategories, getExcludedCategories, isPipelinePaused } from '@/lib/settings'
import { withStationAuth } from '@/lib/auth'
import { ACTIVE_REVIEW_STATUSES } from '@/lib/compliance-status'
import { getCurrentQuarter, getCurrentQuarterBounds } from '@/lib/quarters'

export const dynamic = 'force-dynamic'

function getQuarterBounds() {
  const { year, quarter } = getCurrentQuarter()
  const { start, end } = getCurrentQuarterBounds()
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

export const GET = withStationAuth(async (ctx) => {
  const { supabase, stationId, isSuperAdmin } = ctx

  const qtr = getQuarterBounds()

  const [
    statusCounts,
    qtrStatusCounts,
    recentEpisodes,
    recentActivity,
    activityUsage,
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
    qualityFlagEpisodes,
    lastFiledQir,
    lastCompletedJobs,
  ] = await Promise.all([
    // 1. Overall status counts
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabase
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('station_id', stationId)
          .eq('status', s)
        return [s, count ?? 0] as const
      })
    ),

    // 2. Quarter-specific status counts (include null air_date episodes by created_at)
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabase
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('station_id', stationId)
          .eq('status', s)
          .or(`and(air_date.gte.${qtr.start},air_date.lte.${qtr.end}),and(air_date.is.null,created_at.gte.${qtr.start}T00:00:00Z,created_at.lte.${qtr.end}T23:59:59Z)`)
        return [s, count ?? 0] as const
      })
    ),

    // 3. Recently updated episodes
    supabase
      .from('episode_log')
      .select('id, show_name, headline, status, updated_at, air_date, issue_category')
      .eq('station_id', stationId)
      .order('updated_at', { ascending: false })
      .limit(15),

    // 4. Recently processed (48h for day grouping)
    supabase
      .from('episode_log')
      .select('id, show_name, status, updated_at, headline, show_key')
      .eq('station_id', stationId)
      .gte('updated_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
      .order('updated_at', { ascending: false })
      .limit(50),

    // 4b. Usage log for recent activity (duration/cost per episode)
    supabase
      .from('usage_log')
      .select('episode_id, operation, duration_seconds, estimated_cost')
      .eq('station_id', stationId)
      .gte('created_at', new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()),

    // 5. Usage/cost for this quarter
    supabase
      .from('usage_log')
      .select('*')
      .eq('station_id', stationId)
      .gte('created_at', qtr.start)
      .lte('created_at', qtr.end + 'T23:59:59'),

    // 6. Daily costs for last 30 days
    supabase
      .from('usage_log')
      .select('created_at, estimated_cost, service, operation')
      .eq('station_id', stationId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: true }),

    // 7. Issue category distribution (completed episodes this quarter)
    supabase
      .from('episode_log')
      .select('issue_category')
      .eq('station_id', stationId)
      .in('status', ['summarized', 'compliance_checked'])
      .or(`and(air_date.gte.${qtr.start},air_date.lte.${qtr.end}),and(air_date.is.null,created_at.gte.${qtr.start}T00:00:00Z,created_at.lte.${qtr.end}T23:59:59Z)`),

    // 8. Show distribution (this quarter)
    supabase
      .from('episode_log')
      .select('show_name, show_key, status')
      .eq('station_id', stationId)
      .or(`and(air_date.gte.${qtr.start},air_date.lte.${qtr.end}),and(air_date.is.null,created_at.gte.${qtr.start}T00:00:00Z,created_at.lte.${qtr.end}T23:59:59Z)`),

    // 9-12. Queue status
    getQueueCounts(ingestQueue),
    getQueueCounts(transcribeQueue),
    getQueueCounts(summarizeQueue),
    getQueueCounts(complianceQueue),

    // 13. Processing times (last 7 days)
    supabase
      .from('usage_log')
      .select('operation, duration_seconds, estimated_cost, created_at')
      .eq('station_id', stationId)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .not('duration_seconds', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200),

    // 14. Active shows (for coverage gaps)
    supabase
      .from('show_keys')
      .select('key, show_name, category, active')
      .eq('station_id', stationId)
      .eq('active', true),

    // 15. Active compliance flags — investigating + violation (scoped to
    // station via episode_log join)
    supabase
      .from('compliance_flags')
      .select('flag_type, severity, episode_log!inner(station_id)')
      .in('review_status', ACTIVE_REVIEW_STATUSES)
      .eq('episode_log.station_id', stationId),

    // 16. QIR drafts for current quarter
    supabase
      .from('qir_drafts')
      .select('id, status, version, curated_entries')
      .eq('station_id', stationId)
      .eq('year', qtr.year)
      .eq('quarter', qtr.quarter)
      .order('version', { ascending: false })
      .limit(1),

    // 17. Current month usage
    supabase
      .from('usage_log')
      .select('estimated_cost, service')
      .eq('station_id', stationId)
      .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()),

    // 18. Quality flags: episodes with very short transcripts but long duration
    supabase
      .from('episode_log')
      .select('id, show_name, headline, air_date, duration, status')
      .eq('station_id', stationId)
      .in('status', ['transcribed', 'summarized', 'compliance_checked'])
      .gt('duration', 1800)
      .or(`and(air_date.gte.${qtr.start},air_date.lte.${qtr.end}),and(air_date.is.null,created_at.gte.${qtr.start}T00:00:00Z,created_at.lte.${qtr.end}T23:59:59Z)`),

    // 19. Last filed (finalized) QIR
    supabase
      .from('qir_drafts')
      .select('id, year, quarter, version, updated_at')
      .eq('station_id', stationId)
      .eq('status', 'final')
      .order('updated_at', { ascending: false })
      .limit(1),

    // 20. Last completed job timestamp per queue type
    supabase
      .from('usage_log')
      .select('operation, created_at')
      .eq('station_id', stationId)
      .in('operation', ['transcribe', 'summarize', 'compliance', 'ingest'])
      .order('created_at', { ascending: false })
      .limit(20),
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

  // Activity timeline with duration/cost from usage_log
  const activityUsageMap = new Map<number, { duration_seconds: number | null; cost: number | null; operation: string | null }>()
  for (const row of activityUsage.data ?? []) {
    if (row.episode_id && !activityUsageMap.has(row.episode_id)) {
      activityUsageMap.set(row.episode_id, {
        duration_seconds: row.duration_seconds,
        cost: row.estimated_cost ? Number(row.estimated_cost) : null,
        operation: row.operation,
      })
    }
  }

  const activityData = (recentActivity.data ?? []).map((ep) => {
    const usageInfo = activityUsageMap.get(ep.id)
    return {
      id: ep.id,
      show_name: ep.show_name,
      headline: ep.headline,
      status: ep.status,
      show_key: ep.show_key,
      time: ep.updated_at,
      duration_seconds: usageInfo?.duration_seconds ?? null,
      // Cost/spend is super-admin-only; omit for everyone else.
      cost: isSuperAdmin ? (usageInfo?.cost ?? null) : null,
    }
  })

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

  // Coverage gaps — exclude the station's non-issue formats (music/etc.) so the
  // gap list stays meaningful. Honor the per-station excluded_categories setting
  // (so e.g. a station scanning Español still surfaces it as a coverage candidate),
  // falling back to the standard set when a station hasn't configured its own.
  const configuredExclusions = await getExcludedCategories(stationId)
  const excludedShowCategories = configuredExclusions.length ? configuredExclusions : ['Music', 'Español']
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
  const allIssueCategories = await getIssueCategories(stationId)

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

  // Quality flags: filter episodes that might have transcript issues
  // We'll check transcript length for candidates with long duration
  const qualityCandidates = qualityFlagEpisodes.data ?? []
  let qualityFlags: Array<{ id: number; show_name: string | null; headline: string | null; air_date: string | null; reason: string }> = []
  if (qualityCandidates.length > 0) {
    const candidateIds = qualityCandidates.map((e) => e.id)
    const { data: transcripts } = await supabase
      .from('transcripts')
      .select('episode_id, transcript, episode_log!inner(station_id)')
      .eq('episode_log.station_id', stationId)
      .in('episode_id', candidateIds)
    const transcriptLengths = new Map<number, number>()
    for (const t of transcripts ?? []) {
      transcriptLengths.set(t.episode_id, (t.transcript ?? '').length)
    }
    qualityFlags = qualityCandidates
      .filter((e) => {
        const len = transcriptLengths.get(e.id) ?? 0
        return len < 500
      })
      .map((e) => ({
        id: e.id,
        show_name: e.show_name,
        headline: e.headline,
        air_date: e.air_date,
        reason: 'Short transcript for long episode',
      }))
  }

  // Last filed QIR
  const lastFiled = lastFiledQir.data?.[0] ?? null

  // Last completed job per queue type
  const lastJobTimestamps: Record<string, string> = {}
  for (const row of lastCompletedJobs.data ?? []) {
    if (!lastJobTimestamps[row.operation]) {
      lastJobTimestamps[row.operation] = row.created_at
    }
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
    // Cost/spend metrics are super-admin-only — omit the entire block otherwise.
    ...(isSuperAdmin ? {
      cost: {
        quarter: { groq: usage.groq, openai: usage.openai, total: usage.total, episodeCount: usage.episodes.size, apiCalls: usage.apiCalls },
        daily: dailyCostData,
        month: { groq: monthGroq, openai: monthOpenai, total: monthGroq + monthOpenai },
      },
    } : {}),
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
    qualityFlags,
    lastFiledQir: lastFiled,
    lastCompletedJobs: lastJobTimestamps,
    pipelinePaused: await isPipelinePaused(),
  })
})
