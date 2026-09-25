import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'
import { getStripPrefixes } from '@/lib/stations'
import { resolveShowDisplayName } from '@/lib/shows'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/shows — this station's programs. Defaults to active shows; pass
// ?active=all to include inactive (un-onboarded) ones.
//
// display_name is the OFFICIAL consumer-facing label: the same resolution the
// dashboard uses (manual override verbatim → feed-derived → legacy → key, with
// the station's prefixes stripped and whitespace collapsed — lib/shows.ts).
// feed_name/show_name stay verbatim as provenance; render display_name.
export const GET = withApiKey(
  async (request, { ctx }) => {
    const active = request.nextUrl.searchParams.get('active') ?? 'true'

    let query = supabaseAdmin
      .from('show_keys')
      .select('key, show_group, display_name, feed_name, show_name, category, primary_language, active')
      .eq('station_id', ctx.stationId)
      .order('key', { ascending: true })

    if (active !== 'all') query = query.eq('active', active !== 'false')

    const [{ data, error }, stripPrefixes] = await Promise.all([query, getStripPrefixes(ctx.stationId)])
    if (error) return { json: { error: error.message }, status: 500 }

    const shows = (data ?? []).map((s) => ({
      ...s,
      display_name: resolveShowDisplayName(s, stripPrefixes).replace(/\s+/g, ' ').trim(),
    }))
    return { json: { shows } }
  },
  { scope: 'shows', cache: { resource: 'shows', ttlSec: 300 } },
)
