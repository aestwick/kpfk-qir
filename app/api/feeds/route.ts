import { NextResponse } from 'next/server'
import { supabaseAdmin } from '../../../lib/supabase'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { data: shows, error } = await supabaseAdmin
    .from('show_keys')
    .select('key, show_name, category, active')
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
    feed_url: `${baseUrl}/api/feeds/${s.key}`,
  }))

  return NextResponse.json({ feeds })
}
