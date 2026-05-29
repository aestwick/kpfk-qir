import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import { createServerClient, supabaseAdmin } from '@/lib/supabase'
import { StationRole } from '@/lib/types'

// Header/cookie the dashboard uses to declare which station the request acts on.
// The client (station switcher) is responsible for setting this; the server
// never guesses an active station (see STATION_CONTEXT_MISSING below).
export const STATION_HEADER = 'x-station-slug'
export const STATION_COOKIE = 'qir_station'

export interface StationContext {
  userId: string
  role: StationRole
  stationId: string
  stationSlug: string
  // All stations the user may access (their memberships, or every station if
  // super_admin). Lets routes/switcher reason about multi-station access.
  allowedStationIds: string[]
  isSuperAdmin: boolean
  // Request-scoped, RLS-enforcing client. Routes must use this for user actions.
  supabase: SupabaseClient
}

export interface StationContextError {
  status: 401 | 403 | 400
  error: string
}

export type StationContextResult =
  | { context: StationContext; error?: undefined }
  | { context?: undefined; error: StationContextError }

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function requestedStationSlug(request: NextRequest): string | null {
  const fromHeader = request.headers.get(STATION_HEADER)
  if (fromHeader) return fromHeader
  return request.cookies.get(STATION_COOKIE)?.value ?? null
}

/**
 * Resolve the caller's identity, their allowed stations, and the active station
 * for this request. Returns a request-scoped RLS client bound to the caller's
 * token. On any failure returns a clear { error: { status, error } } — never a
 * silently-defaulted station (a wrong default would be a cross-tenant leak).
 */
export async function getStationContext(request: NextRequest): Promise<StationContextResult> {
  const token = bearerToken(request)
  if (!token) {
    return { error: { status: 401, error: 'Missing bearer token' } }
  }

  const supabase = createServerClient(token)

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData?.user) {
    return { error: { status: 401, error: 'Invalid or expired session' } }
  }
  const userId = userData.user.id

  // Super admins may access every station; everyone else only their memberships.
  const { data: superRow, error: superError } = await supabase
    .from('super_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (superError) {
    return { error: { status: 401, error: `Failed to resolve admin status: ${superError.message}` } }
  }
  const isSuperAdmin = !!superRow

  let allowed: { station_id: string; slug: string; role: StationRole }[]
  if (isSuperAdmin) {
    const { data, error } = await supabase
      .from('stations')
      .select('id, slug')
    if (error) {
      return { error: { status: 401, error: `Failed to load stations: ${error.message}` } }
    }
    allowed = (data ?? []).map((s) => ({ station_id: s.id, slug: s.slug, role: 'admin' as StationRole }))
  } else {
    const { data, error } = await supabase
      .from('station_users')
      .select('station_id, role, stations!inner(slug)')
      .eq('user_id', userId)
    if (error) {
      return { error: { status: 401, error: `Failed to load memberships: ${error.message}` } }
    }
    allowed = (data ?? []).map((row) => {
      // stations!inner is a single related row; supabase-js types it as object|array.
      const station = Array.isArray(row.stations) ? row.stations[0] : row.stations
      return { station_id: row.station_id, slug: station.slug, role: row.role as StationRole }
    })
  }

  if (allowed.length === 0) {
    return { error: { status: 403, error: 'User belongs to no station' } }
  }

  const slug = requestedStationSlug(request)
  if (!slug) {
    // The client must declare the active station. Do not default it server-side.
    return { error: { status: 400, error: 'No active station selected' } }
  }

  const match = allowed.find((s) => s.slug === slug)
  if (!match) {
    return { error: { status: 403, error: `No access to station '${slug}'` } }
  }

  return {
    context: {
      userId,
      role: match.role,
      stationId: match.station_id,
      stationSlug: match.slug,
      allowedStationIds: allowed.map((s) => s.station_id),
      isSuperAdmin,
      supabase,
    },
  }
}

/** Map a StationContextError to a JSON NextResponse with the right status. */
export function stationErrorResponse(error: StationContextError): NextResponse {
  return NextResponse.json({ error: error.error }, { status: error.status })
}

/**
 * Resolve a station id from a URL-safe slug using the service-role client (no
 * user JWT). For public/no-auth paths only — the SSE activity stream (scoped by
 * the qir_station cookie) and public RSS feeds (scoped by an explicit ?station
 * slug). Returns null when the slug is missing or unknown. Callers MUST handle
 * null explicitly rather than defaulting to a station.
 */
export async function resolveStationIdBySlug(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  if (error) {
    console.error(`resolveStationIdBySlug('${slug}') failed:`, error.message)
    return null
  }
  return data?.id ?? null
}

/** Read the active-station slug from the qir_station cookie (SSE path). */
export function stationSlugFromCookie(request: NextRequest): string | null {
  return request.cookies.get(STATION_COOKIE)?.value ?? null
}
