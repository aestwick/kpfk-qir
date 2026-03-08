import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { ingestQueue, transcribeQueue, summarizeQueue } from '@/lib/queue'

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

  // Run all queries in parallel
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
    processingTimes,
  ] = await Promise.all([
    // 1. Overall status counts
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabaseAdmin
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('status', s)
        return [s, count ?? 0] as const
      })
    ),

    // 2. Quarter-specific status counts
    Promise.all(
      (['pending', 'transcribed', 'summarized', 'failed', 'unavailable'] as const).map(async (s) => {
        const { count } = await supabaseAdmin
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('status', s)
          .gte('air_date', qtr.start)
          .lte('air_date', qtr.end)
        return [s, count ?? 0] as const
      })
    ),

    // 3. Recently updated episodes (last 15)
    supabaseAdmin
      .from('episode_log')
      .select('id, show_name, headline, status, updated_at, air_date, issue_category')
      .order('updated_at', { ascending: false })
      .limit(15),

    // 4. Recently processed (status changes in last 24h)
    supabaseAdmin
      .from('episode_log')
      .select('id, show_name, status, updated_at')
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

    // 7. Issue category distribution (summarized episodes this quarter)
    supabaseAdmin
      .from('episode_log')
      .select('issue_category')
      .eq('status', 'summarized')
      .gte('air_date', qtr.start)
      .lte('air_date', qtr.end),

    // 8. Show distribution (this quarter)
    supabaseAdmin
      .from('episode_log')
      .select('show_name, status')
      .gte('air_date', qtr.start)
      .lte('air_date', qtr.end),

    // 9-11. Queue status
    getQueueCounts(ingestQueue),
    getQueueCounts(transcribeQueue),
    getQueueCounts(summarizeQueue),

    // 12. Processing time stats from usage_log
    supabaseAdmin
      .from('usage_log')
      .select('operation, duration_seconds, estimated_cost, created_at')
      .not('duration_seconds', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200),
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

  // Daily cost aggregation for sparkline
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
    if (row.status === 'summarized') entry.summarized++
    shows.set(name, entry)
  }
  const showData = Array.from(shows.entries())
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15)

  // Recent activity: group by status for the 24h timeline
  const activityData = (recentActivity.data ?? []).map((ep) => ({
    id: ep.id,
    show_name: ep.show_name,
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
    },
    cost: {
      quarter: { groq: usage.groq, openai: usage.openai, total: usage.total, episodeCount: usage.episodes.size, apiCalls: usage.apiCalls },
      daily: dailyCostData,
    },
    categories: categoryData,
    shows: showData,
    recentEpisodes: (recentEpisodes.data ?? []).slice(0, 15),
    activity24h: activityData,
    avgProcessingTimes,
  })
}
