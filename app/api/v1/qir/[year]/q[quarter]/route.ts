import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/qir/{year}/q{quarter} — the latest FINALIZED report for a quarter,
// including its curated entries. 404 when no finalized report exists.
export const GET = withApiKey(
  async (_request, { ctx, params }) => {
    const year = parseInt(params.year)
    const quarter = parseInt(params.quarter)
    if (isNaN(year) || isNaN(quarter) || quarter < 1 || quarter > 4) {
      return { json: { error: 'Invalid year or quarter' }, status: 400 }
    }

    const { data, error } = await supabaseAdmin
      .from('qir_drafts')
      .select('id, year, quarter, status, version, curated_entries, curated_text, created_at, updated_at')
      .eq('station_id', ctx.stationId)
      .eq('year', year)
      .eq('quarter', quarter)
      .eq('status', 'final')
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return { json: { error: error.message }, status: 500 }
    if (!data) return { json: { error: 'No finalized report for that quarter' }, status: 404 }
    return { json: { report: data } }
  },
  { scope: 'qir', cache: { resource: 'qir', ttlSec: 3600 } },
)
