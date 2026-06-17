import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// GET /api/v1/usage — AI cost/usage summary for this station, aggregated by
// service. Filters: ?from, ?to (ISO dates, on created_at). Returns per-service
// totals plus an overall total.
export const GET = withApiKey(
  async (request, { ctx }) => {
    const sp = request.nextUrl.searchParams
    const from = sp.get('from')
    const to = sp.get('to')

    let query = supabaseAdmin
      .from('usage_log')
      .select('service, model, input_tokens, output_tokens, duration_seconds, estimated_cost, created_at')
      .eq('station_id', ctx.stationId)

    if (from) query = query.gte('created_at', from)
    if (to) query = query.lte('created_at', to)

    const { data, error } = await query
    if (error) return { json: { error: error.message }, status: 500 }

    const rows = data ?? []
    const byService: Record<string, { calls: number; input_tokens: number; output_tokens: number; cost: number }> = {}
    let totalCost = 0
    for (const r of rows) {
      const s = (byService[r.service] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cost: 0 })
      s.calls += 1
      s.input_tokens += r.input_tokens ?? 0
      s.output_tokens += r.output_tokens ?? 0
      const cost = r.estimated_cost ?? 0
      s.cost += cost
      totalCost += cost
    }

    return { json: { total_calls: rows.length, total_cost: totalCost, by_service: byService } }
  },
  { scope: 'usage', cache: { resource: 'usage', ttlSec: 60 } },
)
