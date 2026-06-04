import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId, isSuperAdmin } = ctx

    // Cost/spend data is super-admin-only. Non-admins (incl. station admins)
    // get a 403 — the dashboard and activity pages degrade gracefully when this
    // endpoint is denied (no cost annotations shown).
    if (!isSuperAdmin) {
      return NextResponse.json({ error: 'Usage and cost data is restricted to super-admins' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    let query = supabase
      .from('usage_log')
      .select('*')
      .eq('station_id', stationId)
      .order('created_at', { ascending: false })

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    const { data, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Calculate totals
    const episodes = new Set<number>()
    let groqCost = 0
    let openaiCost = 0
    let totalCost = 0
    let totalDurationSeconds = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0

    const byOperation: Record<string, {
      cost: number
      count: number
      durationSeconds: number
      inputTokens: number
      outputTokens: number
    }> = {}

    for (const row of data ?? []) {
      const cost = Number(row.estimated_cost) || 0
      const dur = Number(row.duration_seconds) || 0
      const inTok = Number(row.input_tokens) || 0
      const outTok = Number(row.output_tokens) || 0

      totalCost += cost
      totalDurationSeconds += dur
      totalInputTokens += inTok
      totalOutputTokens += outTok

      if (row.service === 'groq') groqCost += cost
      if (row.service === 'openai') openaiCost += cost
      if (row.episode_id) episodes.add(row.episode_id)

      if (!byOperation[row.operation]) {
        byOperation[row.operation] = { cost: 0, count: 0, durationSeconds: 0, inputTokens: 0, outputTokens: 0 }
      }
      const op = byOperation[row.operation]
      op.cost += cost
      op.count++
      op.durationSeconds += dur
      op.inputTokens += inTok
      op.outputTokens += outTok
    }

    return NextResponse.json({
      entries: data,
      totals: {
        groq: groqCost,
        openai: openaiCost,
        total: totalCost,
        episodeCount: episodes.size,
        totalDurationSeconds,
        totalInputTokens,
        totalOutputTokens,
        byOperation,
      },
    })
  } catch (err) {
    console.error('GET /api/usage failed:', err)
    return NextResponse.json({ error: 'Failed to fetch usage data' }, { status: 500 })
  }
})
