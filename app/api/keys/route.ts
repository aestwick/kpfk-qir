import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { generateApiKey } from '@/lib/api-auth'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'
import type { ApiScope } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const VALID_SCOPES: ApiScope[] = ['qir', 'episodes', 'transcripts', 'shows', 'usage']

// GET /api/keys — list the active station's API keys (metadata only; the secret
// is never returned). Any station member may view; the RLS client scopes rows.
export async function GET(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const { supabase, stationId } = result.context

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, name, key_prefix, scopes, rate_limit_per_min, active, last_used_at, created_at')
    .eq('station_id', stationId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ keys: data ?? [] })
}

// POST /api/keys — mint a new key (admin only). Returns the raw secret EXACTLY
// once; only its hash is stored. Body: { name, scopes?, rate_limit_per_min? }.
export async function POST(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const denied = requireRole(result.context, 'admin')
  if (denied) return stationErrorResponse(denied)
  const { supabase, stationId, userId } = result.context

  const body = await request.json().catch(() => ({}))
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })

  let scopes: string[] = ['qir', 'episodes', 'shows', 'usage']
  if (Array.isArray(body.scopes)) {
    const invalid = body.scopes.filter((s: string) => !VALID_SCOPES.includes(s as ApiScope))
    if (invalid.length) return NextResponse.json({ error: `Invalid scopes: ${invalid.join(', ')}` }, { status: 400 })
    scopes = body.scopes
  }

  const rateLimit = Number.isInteger(body.rate_limit_per_min) ? body.rate_limit_per_min : 60
  const { raw, hash, prefix } = generateApiKey()

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      station_id: stationId,
      name,
      key_prefix: prefix,
      key_hash: hash,
      scopes,
      rate_limit_per_min: rateLimit,
      created_by: userId,
    })
    .select('id, name, key_prefix, scopes, rate_limit_per_min, active, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const meta = requestMeta(request)
  void logAuditEvent({
    action: AUDIT_ACTIONS.API_KEY_CREATE,
    operation: 'insert',
    actorId: userId,
    stationId,
    resourceType: 'api_key',
    resourceId: data.id,
    metadata: { name, scopes },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  // `key` is the only time the raw secret is ever exposed — surface it to the UI.
  return NextResponse.json({ key: raw, record: data }, { status: 201 })
}

// PATCH /api/keys — revoke or re-activate a key (admin only). Body: { id, active }.
export async function PATCH(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const denied = requireRole(result.context, 'admin')
  if (denied) return stationErrorResponse(denied)
  const { supabase, stationId, userId } = result.context

  const body = await request.json().catch(() => ({}))
  const id = body.id
  if (!id || typeof body.active !== 'boolean') {
    return NextResponse.json({ error: 'id and active (boolean) are required' }, { status: 400 })
  }

  const { error } = await supabase
    .from('api_keys')
    .update({ active: body.active })
    .eq('id', id)
    .eq('station_id', stationId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const meta = requestMeta(request)
  void logAuditEvent({
    action: AUDIT_ACTIONS.API_KEY_REVOKE,
    operation: 'update',
    actorId: userId,
    stationId,
    resourceType: 'api_key',
    resourceId: id,
    metadata: { active: body.active },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return NextResponse.json({ ok: true, active: body.active })
}

// DELETE /api/keys?id= — permanently delete a key (admin only).
export async function DELETE(request: NextRequest) {
  const result = await getStationContext(request)
  if (result.error) return stationErrorResponse(result.error)
  const denied = requireRole(result.context, 'admin')
  if (denied) return stationErrorResponse(denied)
  const { supabase, stationId, userId } = result.context

  const id = request.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { error } = await supabase
    .from('api_keys')
    .delete()
    .eq('id', parseInt(id))
    .eq('station_id', stationId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const meta = requestMeta(request)
  void logAuditEvent({
    action: AUDIT_ACTIONS.API_KEY_REVOKE,
    operation: 'delete',
    actorId: userId,
    stationId,
    resourceType: 'api_key',
    resourceId: id,
    metadata: { deleted: true },
    ip: meta.ip,
    userAgent: meta.userAgent,
  })

  return NextResponse.json({ ok: true })
}
