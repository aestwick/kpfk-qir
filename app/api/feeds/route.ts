import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../lib/supabase'
import { resolveStationIdBySlug } from '../../../lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  // Public feed listing scoped by an explicit ?station=<slug>. Never default.
  const { searchParams } = new URL(request.url)
  const slug = searchParams.get('station')
  const stationId = await resolveStationIdBySlug(slug)
  if (!stationId) {
    return NextResponse.json({ error: 'Unknown or missing station' }, { status: 400 })
  }

  const { data: shows, error } = await supabaseAdmin
    .from('show_keys')
    .select('key, show_name, category, active')
    .eq('station_id', stationId)
    .eq('active', true)
    .order('show_name')

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://qir.kpfk.org'

  const feeds = (shows || []).map((s) => ({
    show_key: s.key,
    show_name: s.show_name,
    category: s.category,
    feed_url: `${baseUrl}/api/feeds/${s.key}?station=${slug}`,
  }))

  return NextResponse.json({ feeds })
}
