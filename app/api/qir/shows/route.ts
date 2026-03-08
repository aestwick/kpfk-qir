import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getQuarterDateRange } from '@/lib/qir-format'

export const dynamic = 'force-dynamic'

/**
 * GET /api/qir/shows?year=2026&quarter=1
 * Returns shows that have summarized episodes in the given quarter,
 * with episode counts per show.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const year = parseInt(searchParams.get('year') ?? '')
    const quarter = parseInt(searchParams.get('quarter') ?? '')

    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return NextResponse.json({ error: 'Valid year and quarter (1-4) required' }, { status: 400 })
    }

    const { start, end } = getQuarterDateRange(year, quarter)

    // Get all completed episodes in this quarter
    const { data: episodes, error } = await supabaseAdmin
      .from('episode_log')
      .select('show_key, show_name')
      .in('status', ['summarized', 'compliance_checked'])
      .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Aggregate by show
    const showMap = new Map<string, { show_key: string; show_name: string; episode_count: number }>()
    for (const ep of episodes ?? []) {
      const key = ep.show_key
      const existing = showMap.get(key)
      if (existing) {
        existing.episode_count++
      } else {
        showMap.set(key, {
          show_key: key,
          show_name: ep.show_name ?? key,
          episode_count: 1,
        })
      }
    }

    const shows = Array.from(showMap.values()).sort((a, b) =>
      a.show_name.localeCompare(b.show_name)
    )

    return NextResponse.json({ shows })
  } catch (err) {
    console.error('GET /api/qir/shows failed:', err)
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 })
  }
}
