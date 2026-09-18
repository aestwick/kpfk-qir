import { supabaseAdmin } from '@/lib/supabase'
import { withApiKey } from '@/lib/api-handler'
import {
  FEED_SELECT,
  parseFeedRequest,
  keysetFilter,
  buildCursorEnvelope,
  type FeedFilters,
  type FeedRow,
} from '@/lib/episode-feed'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ===========================================================================
// GET /api/v1/episodes — the published episode feed.
//
// Read-only, API-key authenticated (Authorization: Bearer <key>), scoped to one
// station, and restricted to PUBLISHED episodes only: the pipeline's internal
// states are not reachable here. Columns are an explicit allowlist (FEED_SELECT)
// rather than `select=*`, so adding an internal column to episode_log never
// silently widens the contract.
//
// Incremental sync, the intended use:
//     GET /api/v1/episodes?updated_since=<last updated_at you saw>
//     → { data: [...], next_cursor: "…", has_more: true }
//     GET /api/v1/episodes?updated_since=…&cursor=<next_cursor>   … until
//       next_cursor is null. Re-syncs are idempotent: public_id is stable, so a
//       consumer upserts on it rather than accumulating duplicates.
//
// Filters: updated_since, cursor, limit (≤200), show_key (Confessor key, or a
// comma-separated list), category (FCC issue category), air_date_from,
// air_date_to, status (only within the published set).
//
// Pagination is keyset on (updated_at, id) ascending — stable while workers are
// writing, which offset pagination is not. There is no offset mode: the retired
// page/sort/order/since parameters are a 400. See lib/episode-feed.ts.
// ===========================================================================

/**
 * Apply the shared published-contract filters to a PostgREST query builder.
 * The builder's generic type isn't exported in a shape a helper can name, so it
 * travels as `any` here — every call below is a standard filter method.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function applyFilters<Q extends { in: any; gte: any; lte: any; eq: any }>(query: Q, filters: FeedFilters): Q {
  query = query.in('status', filters.statuses)
  if (filters.updatedSince) query = query.gte('updated_at', filters.updatedSince)
  if (filters.showKeys?.length) query = query.in('show_key', filters.showKeys)
  if (filters.category) query = query.eq('issue_category', filters.category)
  if (filters.airDateFrom) query = query.gte('air_date', filters.airDateFrom)
  if (filters.airDateTo) query = query.lte('air_date', filters.airDateTo)
  return query
}

export const GET = withApiKey(
  async (request, { ctx }) => {
    const parsed = parseFeedRequest(request.nextUrl.searchParams)
    if (parsed.error) return { json: parsed.error, status: 400 }
    const req = parsed.request

    // Fetch one row past the page so has_more needs no COUNT.
    let query = applyFilters(supabaseAdmin.from('episode_log').select(FEED_SELECT), req.filters)
      .eq('station_id', ctx.stationId)
      .order('updated_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(req.limit + 1)
    if (req.cursor) query = query.or(keysetFilter(req.cursor))

    const { data, error } = await query
    if (error) return { json: { error: error.message }, status: 500 }
    return { json: buildCursorEnvelope((data ?? []) as unknown as FeedRow[], req.limit) }
  },
  // Short TTL: episode rows churn as workers process them. The cursor and
  // ?updated_since are the real load-shedders for a poller; the cache absorbs
  // duplicate bursts (and the strong ETag turns a repeat poll into a 304).
  { scope: 'episodes', cache: { resource: 'episodes', ttlSec: 60 } },
)
