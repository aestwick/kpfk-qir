import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/qir — list this station's quarterly reports. Defaults to finalized
// reports only (the externally meaningful ones); pass ?status=draft|all to widen.
// Filters: ?year, ?quarter.
export const GET = withApiKey(
  async (request, { ctx }) => {
    const sp = request.nextUrl.searchParams
    const status = sp.get('status') ?? 'final'
    const year = sp.get('year')
    const quarter = sp.get('quarter')

    let query = supabaseAdmin
      .from('qir_drafts')
      .select('id, year, quarter, status, version, curated_entries, created_at, updated_at')
      .eq('station_id', ctx.stationId)
      .order('year', { ascending: false })
      .order('quarter', { ascending: false })
      .order('version', { ascending: false })

    if (status !== 'all') query = query.eq('status', status)
    if (year) query = query.eq('year', parseInt(year))
    if (quarter) query = query.eq('quarter', parseInt(quarter))

    const { data, error } = await query
    if (error) return { json: { error: error.message }, status: 500 }
    return { json: { reports: data ?? [] } }
  },
  { scope: 'qir', cache: { resource: 'qir', ttlSec: 3600 } },
)
