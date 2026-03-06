import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

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
    const totals = {
      groq: 0,
      openai: 0,
      total: 0,
      episodes: new Set<number>(),
      byOperation: {} as Record<string, number>,
    }

    for (const row of data ?? []) {
      const cost = Number(row.estimated_cost) || 0
      totals.total += cost
      if (row.service === 'groq') totals.groq += cost
      if (row.service === 'openai') totals.openai += cost
      if (row.episode_id) totals.episodes.add(row.episode_id)
      totals.byOperation[row.operation] =
        (totals.byOperation[row.operation] ?? 0) + cost
    }

    return NextResponse.json({
      entries: data,
      totals: {
        groq: totals.groq,
        openai: totals.openai,
        total: totals.total,
        episodeCount: totals.episodes.size,
        byOperation: totals.byOperation,
      },
    })
  } catch (err) {
    console.error('GET /api/usage failed:', err)
    return NextResponse.json({ error: 'Failed to fetch usage data' }, { status: 500 })
  }
}
