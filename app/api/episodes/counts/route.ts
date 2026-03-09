import { NextResponse, NextRequest } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const health = searchParams.get('health') === 'true'

    const statuses = ['pending', 'transcribed', 'summarized', 'compliance_checked', 'failed', 'unavailable', 'transcript_missing', 'dead'] as const
    const counts: Record<string, number> = {}

    await Promise.all(
      statuses.map(async (status) => {
        const { count } = await supabaseAdmin
          .from('episode_log')
          .select('*', { count: 'exact', head: true })
          .eq('status', status)
        counts[status] = count ?? 0
      })
    )

    if (!health) {
      return NextResponse.json(counts)
    }

    // Pipeline health mode: also return stuck/error episodes
    const errorStatuses = ['failed', 'transcript_missing', 'dead']
    const { data: errorEpisodes } = await supabaseAdmin
      .from('episode_log')
      .select('id, show_key, show_name, air_date, status, error_message, created_at, updated_at, retry_count')
      .in('status', errorStatuses)
      .order('updated_at', { ascending: false })
      .limit(100)

    // Also find episodes that have been stuck in a non-terminal status for > 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const { data: stuckEpisodes } = await supabaseAdmin
      .from('episode_log')
      .select('id, show_key, show_name, air_date, status, error_message, created_at, updated_at, retry_count')
      .in('status', ['pending', 'transcribed'])
      .lt('updated_at', twoHoursAgo)
      .order('updated_at', { ascending: true })
      .limit(50)

    return NextResponse.json({
      counts,
      errorEpisodes: errorEpisodes ?? [],
      stuckEpisodes: stuckEpisodes ?? [],
    })
  } catch (err) {
    console.error('GET /api/episodes/counts failed:', err)
    return NextResponse.json({ error: 'Failed to fetch counts' }, { status: 500 })
  }
}
