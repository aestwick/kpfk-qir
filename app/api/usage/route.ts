import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    let query = supabaseAdmin
      .from('usage_log')
      .select('*')
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
}
