import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { StationRole } from '@/lib/types'

export const dynamic = 'force-dynamic'

const VALID_ROLES: StationRole[] = ['viewer', 'editor', 'admin']

// Resolve emails for a set of user ids via the admin auth API. Returns a map of
// user_id -> email. Paginates defensively though member counts are tiny.
async function emailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (userIds.length === 0) return map
  const wanted = new Set(userIds)
  let page = 1
  // Stop once we've matched everyone or run out of users.
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

async function findUserByEmail(email: string): Promise<{ id: string; email: string | null } | null> {
  const target = email.trim().toLowerCase()
  let page = 1
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === target)
    if (hit) return { id: hit.id, email: hit.email ?? null }
    if (data.users.length < 1000) return null
    page++
  }
}

// GET — list members of the active station (admin only).
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const denied = requireRole(result.context, 'admin')
    if (denied) return stationErrorResponse(denied)
    const { stationId, userId } = result.context

    // Authorized as a station admin above; read via the service role so we can
    // also resolve emails from auth.users (not reachable under RLS).
    const { data: rows, error } = await supabaseAdmin
      .from('station_users')
      .select('user_id, role, created_at')
      .eq('station_id', stationId)
      .order('created_at', { ascending: true })
    if (error) throw error

    const emails = await emailsByUserId((rows ?? []).map((r) => r.user_id))
    const members = (rows ?? []).map((r) => ({
      user_id: r.user_id,
      email: emails.get(r.user_id) ?? null,
      role: r.role as StationRole,
      created_at: r.created_at,
      is_self: r.user_id === userId,
    }))

    return NextResponse.json({ members })
  } catch (err) {
    console.error('GET /api/members failed:', err)
    return NextResponse.json({ error: 'Failed to fetch members' }, { status: 500 })
  }
}

// POST — add an existing user by email (or invite a new one) to the active
// station with a role (admin only).
export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const denied = requireRole(result.context, 'admin')
    if (denied) return stationErrorResponse(denied)
    const { stationId } = result.context

    const body = await request.json()
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const role = body.role as StationRole

    if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 })
    if (!VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: 'role must be viewer, editor, or admin' }, { status: 400 })
    }

    // Find an existing account; otherwise send an invite that creates one.
    let user = await findUserByEmail(email)
    let invited = false
    if (!user) {
      const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email)
      if (error) {
        return NextResponse.json(
          { error: `Couldn't invite ${email}: ${error.message}. They may need an account created in Supabase first (check that email sending is configured).` },
          { status: 502 },
        )
      }
      user = { id: data.user.id, email: data.user.email ?? email }
      invited = true
    }

    const { error: upsertError } = await supabaseAdmin
      .from('station_users')
      .upsert({ station_id: stationId, user_id: user.id, role }, { onConflict: 'station_id,user_id' })
    if (upsertError) throw upsertError

    return NextResponse.json({ ok: true, invited, user_id: user.id })
  } catch (err) {
    console.error('POST /api/members failed:', err)
    return NextResponse.json({ error: 'Failed to add member' }, { status: 500 })
  }
}

// PATCH — change a member's role (admin only). Won't demote the last admin.
export async function PATCH(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const denied = requireRole(result.context, 'admin')
    if (denied) return stationErrorResponse(denied)
    const { stationId } = result.context

    const body = await request.json()
    const targetUserId = typeof body.user_id === 'string' ? body.user_id : ''
    const role = body.role as StationRole

    if (!targetUserId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
    if (!VALID_ROLES.includes(role)) {
      return NextResponse.json({ error: 'role must be viewer, editor, or admin' }, { status: 400 })
    }

    if (role !== 'admin') {
      const lastAdmin = await isLastAdmin(stationId, targetUserId)
      if (lastAdmin) {
        return NextResponse.json({ error: "Can't demote the station's only admin" }, { status: 400 })
      }
    }

    const { error } = await supabaseAdmin
      .from('station_users')
      .update({ role })
      .eq('station_id', stationId)
      .eq('user_id', targetUserId)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/members failed:', err)
    return NextResponse.json({ error: 'Failed to update member' }, { status: 500 })
  }
}

// DELETE — remove a member from the active station (admin only). Won't remove
// the last admin or the caller themselves.
export async function DELETE(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const denied = requireRole(result.context, 'admin')
    if (denied) return stationErrorResponse(denied)
    const { stationId, userId } = result.context

    const { searchParams } = new URL(request.url)
    const targetUserId = searchParams.get('user_id')
    if (!targetUserId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })

    if (targetUserId === userId) {
      return NextResponse.json({ error: "You can't remove your own membership" }, { status: 400 })
    }
    if (await isLastAdmin(stationId, targetUserId)) {
      return NextResponse.json({ error: "Can't remove the station's only admin" }, { status: 400 })
    }

    const { error } = await supabaseAdmin
      .from('station_users')
      .delete()
      .eq('station_id', stationId)
      .eq('user_id', targetUserId)
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/members failed:', err)
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
  }
}

// True when `targetUserId` is an admin of `stationId` and the only one.
async function isLastAdmin(stationId: string, targetUserId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('station_users')
    .select('user_id')
    .eq('station_id', stationId)
    .eq('role', 'admin')
  if (error) throw error
  const admins = data ?? []
  return admins.length === 1 && admins[0].user_id === targetUserId
}
