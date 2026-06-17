import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/shows — this station's programs. Defaults to active shows; pass
// ?active=all to include inactive (un-onboarded) ones. display_name resolves the
// preferred label (override → feed-derived → legacy → key), matching lib/shows.ts.
export const GET = withApiKey(
  async (request, { ctx }) => {
    const active = request.nextUrl.searchParams.get('active') ?? 'true'

    let query = supabaseAdmin
      .from('show_keys')
      .select('key, show_group, display_name, feed_name, show_name, category, primary_language, active')
      .eq('station_id', ctx.stationId)
      .order('key', { ascending: true })

    if (active !== 'all') query = query.eq('active', active !== 'false')

    const { data, error } = await query
    if (error) return { json: { error: error.message }, status: 500 }

    const shows = (data ?? []).map((s) => ({
      ...s,
      display_name: s.display_name ?? s.feed_name ?? s.show_name ?? s.key,
    }))
    return { json: { shows } }
  },
  { scope: 'shows', cache: { resource: 'shows', ttlSec: 300 } },
)
