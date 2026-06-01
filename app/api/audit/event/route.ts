import { NextRequest, NextResponse } from 'next/server'
import { createServerClient, supabaseAdmin } from '@/lib/supabase'
import { logAuditEvent, requestMeta, CLIENT_AUDIT_EVENTS } from '@/lib/audit'

export const dynamic = 'force-dynamic'

function bearerToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

// Resolve the station id a user may attribute an event to. Returns the id only
// when the authenticated user actually has access to the slug (membership or
// super-admin), so a client can't mislabel an event onto another tenant. Returns
// null otherwise — the event still records, just without a (forgeable) station.
async function resolveAccessibleStationId(userId: string, slug: string): Promise<string | null> {
  const { data: station } = await supabaseAdmin.from('stations').select('id').eq('slug', slug).maybeSingle()
  if (!station) return null
  const { data: sa } = await supabaseAdmin.from('super_admins').select('user_id').eq('user_id', userId).maybeSingle()
  if (sa) return station.id
  const { data: member } = await supabaseAdmin
    .from('station_users')
    .select('station_id')
    .eq('user_id', userId)
    .eq('station_id', station.id)
    .maybeSingle()
  return member ? station.id : null
}

// POST — record a client-reported auth/station event. Only the allowlisted
// actions in CLIENT_AUDIT_EVENTS are accepted; anything else is rejected so a
// client can't forge arbitrary audit rows. Most actions require a valid session;
// `login_failed` is the one anonymous-permitted event (there's no session yet).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = typeof body.action === 'string' ? body.action : ''
    const spec = CLIENT_AUDIT_EVENTS[action]
    if (!spec) {
      return NextResponse.json({ error: 'Unknown or disallowed audit action' }, { status: 400 })
    }

    const metadata: Record<string, unknown> =
      body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    const stationSlug = typeof body.stationSlug === 'string' ? body.stationSlug : null
    const { ip, userAgent } = requestMeta(request)

    // Resolve the actor from the bearer token, if any.
    let actorId: string | null = null
    const token = bearerToken(request)
    if (token) {
      const supabase = createServerClient(token)
      const { data, error } = await supabase.auth.getUser()
      if (!error && data?.user) actorId = data.user.id
    }

    if (!actorId && !spec.anonymousOk) {
      return NextResponse.json({ error: 'A valid session is required for this event' }, { status: 401 })
    }

    const stationId = actorId && stationSlug ? await resolveAccessibleStationId(actorId, stationSlug) : null

    await logAuditEvent({
      action,
      operation: spec.operation,
      actorId,
      anonymous: !actorId,
      stationId,
      resourceType: 'session',
      metadata,
      ip,
      userAgent,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('POST /api/audit/event failed:', err)
    // Audit capture must never break the client flow it's attached to.
    return NextResponse.json({ ok: false }, { status: 200 })
  }
}
