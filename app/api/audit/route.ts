import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import type { AuditLogWithActor } from '@/lib/types'

export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const TRAILING_WINDOW_DAYS = 30

// Resolve emails for a set of user ids via the admin auth API (the audit table
// stores only UUIDs). Mirrors app/api/members/route.ts#emailsByUserId.
async function emailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  const wanted = new Set(userIds.filter(Boolean))
  if (wanted.size === 0) return map
  let page = 1
  while (wanted.size > map.size) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    for (const u of data.users) {
      if (wanted.has(u.id)) map.set(u.id, u.email ?? null)
    }
    if (data.users.length < 1000) break
    page++
  }
  return map
}

// GET — paginated audit log for super-admins only. Defaults to a trailing 30-day
// window (the DB keeps everything forever; the UI just doesn't render all of
// history at once). Returns the in-window total (for pagination) and the
// total ignoring the window (so the UI can show "X of Y").
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)

    // Hard gate: super-admins only. RLS also restricts rows, but fail loud here.
    if (!result.context.isSuperAdmin) {
      return NextResponse.json({ error: 'Audit log is restricted to super-admins' }, { status: 403 })
    }
    const { supabase } = result.context

    const { searchParams } = new URL(request.url)
    const page = Math.max(parseInt(searchParams.get('page') ?? '1') || 1, 1)
    const pageSize = Math.min(
      Math.max(parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE)) || DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    )
    const offset = (page - 1) * pageSize

    const actorId = searchParams.get('actorId')
    const action = searchParams.get('action')
    const resourceType = searchParams.get('resourceType')
    const operation = searchParams.get('operation')
    const stationId = searchParams.get('stationId')
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const q = searchParams.get('q')?.trim()

    // Apply every filter EXCEPT the date window to a query builder. Reused twice:
    // once for the unwindowed total ("Y"), once (plus the window) for the page.
    // Typed loosely (the builder is the same chainable shape for both queries).
    const applyFilters = (query: any): any => {
      let qb = query
      if (actorId) qb = qb.eq('actor_id', actorId)
      if (action) qb = qb.eq('action', action)
      if (resourceType) qb = qb.eq('resource_type', resourceType)
      if (operation) qb = qb.eq('operation', operation)
      if (stationId) qb = qb.eq('station_id', stationId)
      if (q) qb = qb.or(`action.ilike.%${q}%,resource_id.ilike.%${q}%,resource_type.ilike.%${q}%`)
      return qb
    }

    // The trailing window. When `from` is omitted, default to last 30 days; the
    // client clears/widens it to reach the full retained history.
    const windowFrom = from ?? new Date(Date.now() - TRAILING_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

    // Total matching the active filters, ignoring the date window ("of Y").
    const totalQuery = applyFilters(
      supabase.from('audit_log').select('*', { count: 'exact', head: true }),
    )
    // Windowed page of rows + its own count (drives pagination of the view).
    let pageQuery = applyFilters(
      supabase
        .from('audit_log')
        .select('*', { count: 'exact' })
        .gte('created_at', windowFrom)
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1),
    )
    if (to) pageQuery = pageQuery.lte('created_at', to)

    const [{ count: totalUnwindowed, error: totalError }, { data: rows, count: windowTotal, error: pageError }] =
      await Promise.all([totalQuery, pageQuery])

    if (totalError) throw totalError
    if (pageError) throw pageError

    const auditRows = (rows ?? []) as AuditLogWithActor[]
    const emails = await emailsByUserId(auditRows.map((r) => r.actor_id).filter(Boolean) as string[])
    const enriched: AuditLogWithActor[] = auditRows.map((r) => ({
      ...r,
      actor_email: r.actor_id ? emails.get(r.actor_id) ?? null : null,
    }))

    return NextResponse.json({
      rows: enriched,
      page,
      pageSize,
      total: windowTotal ?? 0,           // rows in the current window (paginates the view)
      totalUnwindowed: totalUnwindowed ?? 0, // rows matching filters across all of history
      window: { from: windowFrom, to: to ?? null, defaulted: !from },
    })
  } catch (err) {
    console.error('GET /api/audit failed:', err)
    return NextResponse.json({ error: 'Failed to fetch audit log' }, { status: 500 })
  }
}
