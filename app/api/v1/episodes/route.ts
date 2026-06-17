import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Fields exposed to consumers — episode metadata useful for tag generation
// (summary/headline/guest/category) plus airing/identity info. Transcripts are a
// separate scope + endpoint (/episodes/{id}/transcript).
const SELECT =
  'id, show_key, show_name, category, issue_category, title, headline, host, guest, summary, ' +
  'air_date, air_start, air_end, date, start_time, end_time, duration, status, mp3_url, created_at, updated_at'

// GET /api/v1/episodes — paginated, filterable episode list.
// Filters: ?status, ?show_key, ?category, ?since (updated_at cursor for
// incremental sync), ?page, ?limit (max 200). Ordered by updated_at desc by
// default so a poller can page deltas.
export const GET = withApiKey(
  async (request, { ctx }) => {
    const sp = request.nextUrl.searchParams
    const status = sp.get('status')
    const showKey = sp.get('show_key')
    const category = sp.get('category')
    const since = sp.get('since')
    const sort = sp.get('sort') ?? 'updated_at'
    const order = sp.get('order') ?? 'desc'
    const page = Math.max(1, parseInt(sp.get('page') ?? '1') || 1)
    const limit = Math.min(parseInt(sp.get('limit') ?? '50') || 50, 200)
    const offset = (page - 1) * limit

    let query = supabaseAdmin
      .from('episode_log')
      .select(SELECT, { count: 'exact' })
      .eq('station_id', ctx.stationId)
      .order(sort, { ascending: order === 'asc' })
      .range(offset, offset + limit - 1)

    if (status) query = query.eq('status', status)
    if (showKey) query = query.eq('show_key', showKey)
    if (category) query = query.eq('issue_category', category)
    if (since) query = query.gte('updated_at', since)

    const { data, error, count } = await query
    if (error) return { json: { error: error.message }, status: 500 }
    return { json: { episodes: data ?? [], total: count ?? 0, page, limit } }
  },
  // Short TTL: episode rows churn as workers process them. The ?since cursor is
  // the primary load-shedder for pollers; the cache absorbs duplicate bursts.
  { scope: 'episodes', cache: { resource: 'episodes', ttlSec: 60 } },
)
