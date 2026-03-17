import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// Groq Whisper: $0.111/hr
const GROQ_COST_PER_SECOND = 0.111 / 3600
// OpenAI GPT-4o-mini: ~$0.15/1M input, $0.60/1M output — rough per-episode estimate
const ESTIMATED_SUMMARIZE_COST = 0.003
const ESTIMATED_COMPLIANCE_COST = 0.002

/**
 * GET /api/shows/audit?show_keys=key1,key2&from=2026-01-01&to=2026-01-31
 *
 * Returns episodes for the given shows and date range, grouped by status,
 * with cost estimates for episodes that still need processing.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const showKeysParam = searchParams.get('show_keys')
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    if (!showKeysParam || !from || !to) {
      return NextResponse.json(
        { error: 'show_keys, from, and to parameters are required' },
        { status: 400 }
      )
    }

    const showKeys = showKeysParam.split(',').map((k) => k.trim()).filter(Boolean)
    if (showKeys.length === 0) {
      return NextResponse.json({ error: 'At least one show_key required' }, { status: 400 })
    }

    // Fetch episodes for these shows in the date range
    const { data: episodes, error: epError } = await supabaseAdmin
      .from('episode_log')
      .select('id, show_key, show_name, status, air_date, start_time, duration, headline, host, guest, summary, issue_category, error_message, compliance_status, mp3_url')
      .in('show_key', showKeys)
      .gte('air_date', from)
      .lte('air_date', to)
      .order('air_date', { ascending: true })

    if (epError) throw epError

    const eps = episodes ?? []

    // Fetch compliance flags for these episodes
    const episodeIds = eps.map((e) => e.id)
    let complianceFlags: Array<{ episode_id: number; flag_type: string; severity: string; excerpt: string | null; details: string | null; resolved: boolean }> = []
    if (episodeIds.length > 0) {
      const { data: flags } = await supabaseAdmin
        .from('compliance_flags')
        .select('episode_id, flag_type, severity, excerpt, details, resolved')
        .in('episode_id', episodeIds)
      complianceFlags = flags ?? []
    }

    // Fetch past usage costs for already-processed episodes
    let usageByEpisode: Record<number, number> = {}
    if (episodeIds.length > 0) {
      const { data: usageRows } = await supabaseAdmin
        .from('usage_log')
        .select('episode_id, estimated_cost')
        .in('episode_id', episodeIds)
      for (const row of usageRows ?? []) {
        if (row.episode_id) {
          usageByEpisode[row.episode_id] = (usageByEpisode[row.episode_id] ?? 0) + (Number(row.estimated_cost) || 0)
        }
      }
    }

    // Build status counts
    const statusCounts: Record<string, number> = {}
    for (const ep of eps) {
      statusCounts[ep.status] = (statusCounts[ep.status] ?? 0) + 1
    }

    // Build compliance summary
    const flagsByEpisode: Record<number, typeof complianceFlags> = {}
    for (const flag of complianceFlags) {
      if (!flagsByEpisode[flag.episode_id]) flagsByEpisode[flag.episode_id] = []
      flagsByEpisode[flag.episode_id].push(flag)
    }

    // Estimate costs for unprocessed episodes
    let estimatedTranscribeCost = 0
    let estimatedSummarizeCost = 0
    let estimatedComplianceCost = 0
    const needsTranscription: number[] = []
    const needsSummarization: number[] = []
    const needsCompliance: number[] = []

    for (const ep of eps) {
      if (ep.status === 'pending' || ep.status === 'failed') {
        needsTranscription.push(ep.id)
        const durationSec = (ep.duration ?? 60) * 60
        estimatedTranscribeCost += durationSec * GROQ_COST_PER_SECOND
        // Will also need summarization and compliance after transcription
        needsSummarization.push(ep.id)
        estimatedSummarizeCost += ESTIMATED_SUMMARIZE_COST
        needsCompliance.push(ep.id)
        estimatedComplianceCost += ESTIMATED_COMPLIANCE_COST
      } else if (ep.status === 'transcribed') {
        needsSummarization.push(ep.id)
        estimatedSummarizeCost += ESTIMATED_SUMMARIZE_COST
        needsCompliance.push(ep.id)
        estimatedComplianceCost += ESTIMATED_COMPLIANCE_COST
      } else if (ep.status === 'summarized') {
        needsCompliance.push(ep.id)
        estimatedComplianceCost += ESTIMATED_COMPLIANCE_COST
      }
    }

    // Enrich episodes with compliance flags and cost
    const enrichedEpisodes = eps.map((ep) => ({
      ...ep,
      compliance_flags: flagsByEpisode[ep.id] ?? [],
      actual_cost: usageByEpisode[ep.id] ?? 0,
    }))

    // Issue categories covered
    const issueCategories: Record<string, number> = {}
    for (const ep of eps) {
      if (ep.issue_category) {
        issueCategories[ep.issue_category] = (issueCategories[ep.issue_category] ?? 0) + 1
      }
    }

    return NextResponse.json({
      episodes: enrichedEpisodes,
      total: eps.length,
      statusCounts,
      issueCategories,
      processing: {
        needsTranscription: needsTranscription.length,
        needsSummarization: needsSummarization.length,
        needsCompliance: needsCompliance.length,
        estimatedCost: {
          transcription: Math.round(estimatedTranscribeCost * 1000) / 1000,
          summarization: Math.round(estimatedSummarizeCost * 1000) / 1000,
          compliance: Math.round(estimatedComplianceCost * 1000) / 1000,
          total: Math.round((estimatedTranscribeCost + estimatedSummarizeCost + estimatedComplianceCost) * 1000) / 1000,
        },
      },
      actualCostTotal: Math.round(Object.values(usageByEpisode).reduce((a, b) => a + b, 0) * 1000) / 1000,
    })
  } catch (err) {
    console.error('GET /api/shows/audit failed:', err)
    return NextResponse.json({ error: 'Failed to fetch show audit' }, { status: 500 })
  }
}
