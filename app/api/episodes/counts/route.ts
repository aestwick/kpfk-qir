import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const statuses = ['pending', 'transcribed', 'summarized', 'failed', 'unavailable'] as const
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

    return NextResponse.json(counts)
  } catch (err) {
    console.error('GET /api/episodes/counts failed:', err)
    return NextResponse.json({ error: 'Failed to fetch counts' }, { status: 500 })
  }
}
