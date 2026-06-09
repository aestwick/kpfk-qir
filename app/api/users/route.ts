import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { logAuditEvent, requestMeta, AUDIT_ACTIONS } from '@/lib/audit'
import { emailsByUserId, findOrCreateUser, MIN_PASSWORD_LENGTH } from '@/lib/users'
import { StationRole } from '@/lib/types'

export const dynamic = 'force-dynamic'

// ===========================================================================
// Super-admin user management. The one place that grants access across every
// station and grants/revokes global super-admin. Station admins manage their own
// station's members via /api/members; this route is the broader, super-admin-only
// tool: invite a user, scope them to MULTIPLE stations at once, and toggle the
// global super-admin flag. Hard-gates on isSuperAdmin (RLS would otherwise scope
// reads to memberships) and writes via the service-role client, attributing the
// actor through app-layer audit events.
// ===========================================================================

const VALID_ROLES: StationRole[] = ['viewer', 'editor', 'admin']

interface MembershipInput {
  station_id: string
  role: StationRole
}

// Gate every method on super-admin. Returns the resolved context or a response.
async function requireSuperAdmin(
  request: NextRequest,
): Promise<{ userId: string } | { error: NextResponse }> {
  const result = await getStationContext(request)
  if (result.error) return { error: stationErrorResponse(result.error) }
  if (!result.context.isSuperAdmin) {
    return { error: NextResponse.json({ error: 'User management is restricted to super-admins' }, { status: 403 }) }
  }
  return { userId: result.context.userId }
}

// All user ids that currently hold super-admin (used for last-super protection).
async function superAdminIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('super_admins').select('user_id')
  if (error) throw error
  return (data ?? []).map((r) => r.user_id)
}

function parseMemberships(raw: unknown): MembershipInput[] | { error: string } {
  if (raw == null) return []
  if (!Array.isArray(raw)) return { error: 'stations must be an array' }
  const out: MembershipInput[] = []
  for (const item of raw) {
    const stationId = item && typeof item.station_id === 'string' ? item.station_id : ''
    const role = item ? (item.role as StationRole) : undefined
    if (!stationId) return { error: 'each station entry needs a station_id' }
    if (!role || !VALID_ROLES.includes(role)) {
      return { error: 'each station role must be viewer, editor, or admin' }
    }
    out.push({ station_id: stationId, role })
  }
  return out
}

// GET — list every managed user (anyone with a station membership or super-admin)
// with their email, super status, and per-station roles, plus the station roster
// for the assignment picker. Super-admin only.
export async function GET(request: NextRequest) {
  try {
    const gate = await requireSuperAdmin(request)
    if ('error' in gate) return gate.error

    const [{ data: memberships, error: mErr }, { data: supers, error: sErr }, { data: stations, error: stErr }] =
      await Promise.all([
        supabaseAdmin.from('station_users').select('user_id, station_id, role'),
        supabaseAdmin.from('super_admins').select('user_id'),
        supabaseAdmin.from('stations').select('id, slug, name').order('name'),
      ])
    if (mErr) throw mErr
    if (sErr) throw sErr
    if (stErr) throw stErr

    const superSet = new Set((supers ?? []).map((r) => r.user_id))
    const byUser = new Map<string, { user_id: string; memberships: MembershipInput[] }>()
    superSet.forEach((id) => byUser.set(id, { user_id: id, memberships: [] }))
    for (const row of memberships ?? []) {
      const entry = byUser.get(row.user_id) ?? { user_id: row.user_id, memberships: [] as MembershipInput[] }
      entry.memberships.push({ station_id: row.station_id, role: row.role as StationRole })
      byUser.set(row.user_id, entry)
    }

    const emails = await emailsByUserId(Array.from(byUser.keys()))
    const users = Array.from(byUser.values())
      .map((u) => ({
        user_id: u.user_id,
        email: emails.get(u.user_id) ?? null,
        is_super_admin: superSet.has(u.user_id),
        memberships: u.memberships,
        is_self: u.user_id === gate.userId,
      }))
      .sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''))

    const meta = requestMeta(request)
    void logAuditEvent({
      action: AUDIT_ACTIONS.USERS_READ,
      operation: 'read',
      actorId: gate.userId,
      resourceType: 'station_users',
      metadata: { count: users.length },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return NextResponse.json({ users, stations: stations ?? [] })
  } catch (err) {
    console.error('GET /api/users failed:', err)
    return NextResponse.json({ error: 'Failed to fetch users' }, { status: 500 })
  }
}

// POST — add an existing user by email (or create one with an admin-set
// password, no email sent), grant super-admin if requested, and scope them to
// any number of stations with a role each.
export async function POST(request: NextRequest) {
  try {
    const gate = await requireSuperAdmin(request)
    if ('error' in gate) return gate.error

    const body = await request.json()
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const password = typeof body.password === 'string' ? body.password : undefined
    const makeSuper = body.super === true
    const memberships = parseMemberships(body.stations)
    if (!Array.isArray(memberships)) return NextResponse.json({ error: memberships.error }, { status: 400 })

    if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 })
    if (!makeSuper && memberships.length === 0) {
      return NextResponse.json({ error: 'Pick at least one station, or grant super-admin' }, { status: 400 })
    }

    // Find an existing account, or create one with the admin-set password.
    const found = await findOrCreateUser(email, password)
    if ('error' in found) return NextResponse.json({ error: found.error }, { status: found.status })
    const { user, created } = found

    if (makeSuper) {
      const { error } = await supabaseAdmin
        .from('super_admins')
        .upsert({ user_id: user.id }, { onConflict: 'user_id' })
      if (error) throw error
    }

    for (const m of memberships) {
      const { error } = await supabaseAdmin
        .from('station_users')
        .upsert({ station_id: m.station_id, user_id: user.id, role: m.role }, { onConflict: 'station_id,user_id' })
      if (error) throw error
    }

    const meta = requestMeta(request)
    void logAuditEvent({
      action: AUDIT_ACTIONS.USER_ACCESS_GRANT,
      operation: 'insert',
      actorId: gate.userId,
      resourceType: 'station_users',
      resourceId: user.id,
      metadata: { email, created, super: makeSuper, stations: memberships },
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return NextResponse.json({ ok: true, created, user_id: user.id })
  } catch (err) {
    console.error('POST /api/users failed:', err)
    return NextResponse.json({ error: 'Failed to add user' }, { status: 500 })
  }
}

// PATCH — update an existing user's access. `super` (boolean) grants/revokes the
// global flag; `stations` (when provided) is the user's FULL desired set of
// station roles — stations omitted from it are removed. Super-admins are the
// global backstop, so there's no per-station last-admin guard here (unlike
// /api/members); we only refuse to strip the last super-admin or self-lock.
export async function PATCH(request: NextRequest) {
  try {
    const gate = await requireSuperAdmin(request)
    if ('error' in gate) return gate.error

    const body = await request.json()
    const targetUserId = typeof body.user_id === 'string' ? body.user_id : ''
    if (!targetUserId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })

    const hasSuper = typeof body.super === 'boolean'
    const hasStations = body.stations !== undefined
    const newPassword = typeof body.password === 'string' ? body.password : undefined
    if (!hasSuper && !hasStations && newPassword === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (newPassword !== undefined && newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 })
    }

    // Super-admin grant/revoke.
    if (hasSuper) {
      const makeSuper = body.super === true
      if (!makeSuper) {
        if (targetUserId === gate.userId) {
          return NextResponse.json({ error: "You can't revoke your own super-admin" }, { status: 400 })
        }
        const supers = await superAdminIds()
        if (supers.length === 1 && supers[0] === targetUserId) {
          return NextResponse.json({ error: "Can't revoke the only super-admin" }, { status: 400 })
        }
        const { error } = await supabaseAdmin.from('super_admins').delete().eq('user_id', targetUserId)
        if (error) throw error
      } else {
        const { error } = await supabaseAdmin
          .from('super_admins')
          .upsert({ user_id: targetUserId }, { onConflict: 'user_id' })
        if (error) throw error
      }
    }

    // Replace the user's station memberships with the desired set.
    if (hasStations) {
      const desired = parseMemberships(body.stations)
      if (!Array.isArray(desired)) return NextResponse.json({ error: desired.error }, { status: 400 })

      const { data: current, error: curErr } = await supabaseAdmin
        .from('station_users')
        .select('station_id, role')
        .eq('user_id', targetUserId)
      if (curErr) throw curErr

      const desiredById = new Map(desired.map((m) => [m.station_id, m.role]))
      const currentById = new Map((current ?? []).map((m) => [m.station_id, m.role as StationRole]))

      // Remove memberships no longer desired.
      const toRemove = Array.from(currentById.keys()).filter((id) => !desiredById.has(id))
      if (toRemove.length > 0) {
        const { error } = await supabaseAdmin
          .from('station_users')
          .delete()
          .eq('user_id', targetUserId)
          .in('station_id', toRemove)
        if (error) throw error
      }

      // Upsert additions and role changes.
      const toUpsert = desired.filter((m) => currentById.get(m.station_id) !== m.role)
      for (const m of toUpsert) {
        const { error } = await supabaseAdmin
          .from('station_users')
          .upsert({ station_id: m.station_id, user_id: targetUserId, role: m.role }, { onConflict: 'station_id,user_id' })
        if (error) throw error
      }
    }

    // Reset the account password (no email). Logged as its own sensitive event.
    if (newPassword !== undefined) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(targetUserId, { password: newPassword })
      if (error) return NextResponse.json({ error: `Couldn't reset password: ${error.message}` }, { status: 502 })
    }

    const meta = requestMeta(request)
    if (hasSuper || hasStations) {
      void logAuditEvent({
        action: hasSuper ? (body.super ? AUDIT_ACTIONS.SUPER_ADMIN_GRANT : AUDIT_ACTIONS.SUPER_ADMIN_REVOKE) : AUDIT_ACTIONS.USER_ACCESS_UPDATE,
        operation: 'update',
        actorId: gate.userId,
        resourceType: 'station_users',
        resourceId: targetUserId,
        metadata: { super: hasSuper ? body.super : undefined, stations: hasStations ? body.stations : undefined },
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
    }
    if (newPassword !== undefined) {
      void logAuditEvent({
        action: AUDIT_ACTIONS.USER_PASSWORD_RESET,
        operation: 'update',
        actorId: gate.userId,
        resourceType: 'auth.users',
        resourceId: targetUserId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/users failed:', err)
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
  }
}

// DELETE — revoke all of a user's access: every station membership and the global
// super-admin flag. Won't remove the caller themselves or the last super-admin.
export async function DELETE(request: NextRequest) {
  try {
    const gate = await requireSuperAdmin(request)
    if ('error' in gate) return gate.error

    const { searchParams } = new URL(request.url)
    const targetUserId = searchParams.get('user_id')
    if (!targetUserId) return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
    if (targetUserId === gate.userId) {
      return NextResponse.json({ error: "You can't remove your own access" }, { status: 400 })
    }

    const supers = await superAdminIds()
    if (supers.includes(targetUserId) && supers.length === 1) {
      return NextResponse.json({ error: "Can't remove the only super-admin" }, { status: 400 })
    }

    const { error: suErr } = await supabaseAdmin.from('super_admins').delete().eq('user_id', targetUserId)
    if (suErr) throw suErr
    const { error: muErr } = await supabaseAdmin.from('station_users').delete().eq('user_id', targetUserId)
    if (muErr) throw muErr

    const meta = requestMeta(request)
    void logAuditEvent({
      action: AUDIT_ACTIONS.USER_ACCESS_REVOKE,
      operation: 'delete',
      actorId: gate.userId,
      resourceType: 'station_users',
      resourceId: targetUserId,
      ip: meta.ip,
      userAgent: meta.userAgent,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('DELETE /api/users failed:', err)
    return NextResponse.json({ error: 'Failed to remove user' }, { status: 500 })
  }
}
