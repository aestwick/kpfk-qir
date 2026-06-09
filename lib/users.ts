import { supabaseAdmin } from './supabase'

// ===========================================================================
// Auth-user helpers shared by /api/members (station admins) and /api/users
// (super admins). auth.users isn't reachable under RLS, so these go through the
// service-role admin API. Accounts are created WITHOUT sending email — the admin
// sets a password and hands it over directly (email_confirm marks the account
// usable immediately). This sidesteps the project's shared email config, which
// matters when one Supabase project serves more than one app.
// ===========================================================================

// Supabase's own default minimum is 6; keep in step so createUser doesn't reject.
export const MIN_PASSWORD_LENGTH = 6

// Resolve emails for a set of user ids. Member counts are tiny, but paginate
// defensively (a shared project's auth.users can be large).
export async function emailsByUserId(userIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  if (userIds.length === 0) return map
  const wanted = new Set(userIds)
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

export async function findUserByEmail(email: string): Promise<{ id: string; email: string | null } | null> {
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

export type FindOrCreateResult =
  | { user: { id: string; email: string | null }; created: boolean }
  | { error: string; status: number }

// Find an existing account by email, or create one with an admin-set password
// (no email sent). A password is required ONLY when creating; adding an existing
// account to a station never resets their password. Returns a caller-surfaceable
// { error, status } rather than throwing, so routes can pass the message through.
export async function findOrCreateUser(email: string, password: string | undefined): Promise<FindOrCreateResult> {
  const existing = await findUserByEmail(email)
  if (existing) return { user: existing, created: false }

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return { error: `A password of at least ${MIN_PASSWORD_LENGTH} characters is required to create a new account`, status: 400 }
  }
  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) {
    return { error: `Couldn't create ${email}: ${error.message}`, status: 502 }
  }
  return { user: { id: data.user.id, email: data.user.email ?? email }, created: true }
}
