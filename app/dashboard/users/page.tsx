'use client'

import { useCallback, useEffect, useState } from 'react'
import { authedFetch } from '@/lib/api-client'
import { useToast } from '@/app/components/toast'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { generatePassphrase } from '@/lib/passphrase'
import type { ManagedUser, StationRole } from '@/lib/types'

interface StationLite {
  id: string
  slug: string
  name: string
}

// Per-station role selection: '' means "no access" to that station.
type RoleMap = Record<string, StationRole | ''>

const ROLE_OPTIONS: { value: StationRole | ''; label: string }[] = [
  { value: '', label: 'No access' },
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
]

const ROLE_BADGE: Record<StationRole, string> = {
  admin: 'bg-kpfk-gold/20 text-amber-700 dark:text-amber-300',
  editor: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  viewer: 'bg-warm-200 text-warm-600 dark:bg-warm-700 dark:text-warm-300',
}

// Turn a RoleMap into the API's `stations` payload (dropping "no access").
function toStations(roles: RoleMap): { station_id: string; role: StationRole }[] {
  return Object.entries(roles)
    .filter(([, r]) => r !== '')
    .map(([station_id, role]) => ({ station_id, role: role as StationRole }))
}

// The shared station-role grid used by both the add form and the per-user editor.
function StationRoleGrid({
  stations,
  roles,
  onChange,
}: {
  stations: StationLite[]
  roles: RoleMap
  onChange: (stationId: string, role: StationRole | '') => void
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {stations.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-gray-200 dark:border-warm-700 px-3 py-2">
          <span className="text-sm text-gray-700 dark:text-warm-200 truncate" title={s.name}>{s.name}</span>
          <select
            value={roles[s.id] ?? ''}
            onChange={(e) => onChange(s.id, e.target.value as StationRole | '')}
            className="text-sm rounded-lg px-2 py-1 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100 shrink-0"
          >
            {ROLE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  )
}

export default function UsersPage() {
  const { toast } = useToast()
  const [users, setUsers] = useState<ManagedUser[]>([])
  const [stations, setStations] = useState<StationLite[]>([])
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)

  // Add-user form state.
  const [newEmail, setNewEmail] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newSuper, setNewSuper] = useState(false)
  const [newRoles, setNewRoles] = useState<RoleMap>({})

  // Inline editor state (one user at a time).
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editSuper, setEditSuper] = useState(false)
  const [editRoles, setEditRoles] = useState<RoleMap>({})
  const [resetPassword, setResetPassword] = useState('')

  const [removeTarget, setRemoveTarget] = useState<ManagedUser | null>(null)

  const stationName = useCallback(
    (id: string) => stations.find((s) => s.id === id)?.name ?? id,
    [stations],
  )

  const load = useCallback(async () => {
    try {
      const res = await authedFetch('/api/users')
      if (res.status === 403) {
        setForbidden(true)
        return
      }
      if (!res.ok) {
        setLoadError(true)
        return
      }
      const data = await res.json()
      setUsers(data.users ?? [])
      setStations(data.stations ?? [])
      setForbidden(false)
      setLoadError(false)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function addUser() {
    const email = newEmail.trim()
    if (!email) return
    const stationsPayload = toStations(newRoles)
    if (!newSuper && stationsPayload.length === 0) {
      toast('error', 'Pick at least one station, or grant super-admin')
      return
    }
    const hadPassword = newPassword.trim().length > 0
    setBusy(true)
    try {
      const res = await authedFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: newPassword || undefined, super: newSuper, stations: stationsPayload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to add user'); return }
      // A provided password is ignored when the account already exists (shared
      // auth — likely the other app's user); make that explicit, don't pretend.
      toast('success', data.created ? `Created ${email}` : hadPassword ? `Added ${email} — existing account, password unchanged` : `Added ${email}`)
      setNewEmail(''); setNewPassword(''); setNewSuper(false); setNewRoles({})
      await load()
    } finally {
      setBusy(false)
    }
  }

  function startEdit(u: ManagedUser) {
    setEditingId(u.user_id)
    setEditSuper(u.is_super_admin)
    const roles: RoleMap = {}
    for (const m of u.memberships) roles[m.station_id] = m.role
    setEditRoles(roles)
    setResetPassword('')
  }

  async function resetUserPassword(u: ManagedUser) {
    const password = resetPassword.trim()
    if (!password) return
    setBusy(true)
    try {
      const res = await authedFetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.user_id, password }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to reset password'); return }
      toast('success', `Password reset for ${u.email ?? 'user'}`)
      setResetPassword('')
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(u: ManagedUser) {
    setBusy(true)
    try {
      const res = await authedFetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: u.user_id, super: editSuper, stations: toStations(editRoles) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to update user'); return }
      toast('success', 'Access updated')
      setEditingId(null)
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function removeUser(u: ManagedUser) {
    setBusy(true)
    try {
      const res = await authedFetch(`/api/users?user_id=${encodeURIComponent(u.user_id)}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to remove user'); return }
      toast('success', `Removed ${u.email ?? 'user'}`)
      await load()
    } finally {
      setBusy(false)
      setRemoveTarget(null)
    }
  }

  if (forbidden) {
    return (
      <div className="max-w-2xl">
        <div className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 shadow-card dark:shadow-card-dark p-8 text-center">
          <p className="text-lg font-medium text-gray-900 dark:text-warm-100 mb-1">Restricted</p>
          <p className="text-sm text-gray-500 dark:text-warm-400">
            User management is available to super-admins only. Station admins can manage their own
            station&rsquo;s members from Settings &rarr; Members.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-warm-100">Users</h1>
        <p className="text-sm text-gray-600 dark:text-warm-400 mt-1">
          Manage who can access the platform. <strong>Super-admins</strong> can see and control every
          station and manage users. Per-station roles: <strong>viewers</strong> are read-only,{' '}
          <strong>editors</strong> run the pipeline and edit content, <strong>admins</strong> also
          manage their station&rsquo;s members.
        </p>
      </div>

      {/* Add a user */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4 dark:bg-surface-raised dark:shadow-card-dark">
        <h2 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Add a user</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Email</label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="person@example.org"
              className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-500 dark:text-warm-400">Password</label>
              <button
                type="button"
                onClick={() => setNewPassword(generatePassphrase())}
                className="text-2xs text-blue-600 hover:underline dark:text-blue-400"
              >
                Generate
              </button>
            </div>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New accounts only"
              autoComplete="new-password"
              className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-warm-200 pb-2">
            <input type="checkbox" checked={newSuper} onChange={(e) => setNewSuper(e.target.checked)} className="rounded" />
            Super-admin (all stations)
          </label>
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-warm-400 mb-2">Station access</label>
          <StationRoleGrid
            stations={stations}
            roles={newRoles}
            onChange={(id, role) => setNewRoles((prev) => ({ ...prev, [id]: role }))}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-gray-400 dark:text-warm-500">
            Adding an existing account? Leave the password blank. For a new account, set a starting
            password and share it — no email is sent.
          </p>
          <button
            onClick={addUser}
            disabled={busy || !newEmail.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-100 dark:text-warm-900"
          >
            {busy ? 'Saving…' : 'Add / invite'}
          </button>
        </div>
      </div>

      {/* User list */}
      <div className="bg-white rounded-lg shadow divide-y dark:bg-surface-raised dark:shadow-card-dark dark:divide-warm-700">
        {loading ? (
          <div className="p-3"><SkeletonTableRows rows={4} /></div>
        ) : loadError ? (
          <div className="p-4 text-sm text-red-600 dark:text-red-400 flex items-center justify-between gap-3">
            <span>Couldn&rsquo;t load users.</span>
            <button onClick={() => { setLoading(true); load() }} className="underline underline-offset-2 hover:opacity-80">Retry</button>
          </div>
        ) : users.length === 0 ? (
          <div className="p-4 text-sm text-gray-500 dark:text-warm-400">No users yet.</div>
        ) : (
          users.map((u) => (
            <div key={u.user_id} className="p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-gray-900 dark:text-warm-100 truncate">
                    {u.email ?? u.user_id}
                    {u.is_self && <span className="text-gray-400 dark:text-warm-500"> (you)</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1">
                    {u.is_super_admin && (
                      <span className="text-2xs font-medium px-2 py-0.5 rounded-full bg-kpfk-red/15 text-kpfk-red dark:text-red-300">
                        Super-admin
                      </span>
                    )}
                    {u.memberships.length === 0 && !u.is_super_admin && (
                      <span className="text-xs text-gray-400 dark:text-warm-500">No station access</span>
                    )}
                    {u.memberships.map((m) => (
                      <span key={m.station_id} className={`text-2xs font-medium px-2 py-0.5 rounded-full ${ROLE_BADGE[m.role]}`}>
                        {stationName(m.station_id)} · {m.role}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => (editingId === u.user_id ? setEditingId(null) : startEdit(u))}
                    className="px-2.5 py-1 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-warm-600 dark:text-warm-200 dark:hover:bg-warm-800"
                  >
                    {editingId === u.user_id ? 'Close' : 'Edit'}
                  </button>
                  <button
                    onClick={() => setRemoveTarget(u)}
                    disabled={u.is_self}
                    title={u.is_self ? "You can't remove yourself" : 'Remove all access'}
                    className="px-2.5 py-1 text-sm text-red-600 hover:text-red-700 disabled:opacity-40 dark:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {editingId === u.user_id && (
                <div className="mt-3 rounded-lg bg-gray-50 dark:bg-warm-800/40 p-3 space-y-3">
                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-warm-200">
                    <input
                      type="checkbox"
                      checked={editSuper}
                      onChange={(e) => setEditSuper(e.target.checked)}
                      disabled={u.is_self}
                      className="rounded"
                    />
                    Super-admin (all stations)
                    {u.is_self && <span className="text-xs text-gray-400 dark:text-warm-500">— can&rsquo;t change your own</span>}
                  </label>
                  <StationRoleGrid
                    stations={stations}
                    roles={editRoles}
                    onChange={(id, role) => setEditRoles((prev) => ({ ...prev, [id]: role }))}
                  />
                  <div className="border-t border-gray-200 dark:border-warm-700 pt-3">
                    <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Reset password</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                        placeholder="New password"
                        autoComplete="new-password"
                        className="flex-1 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                      />
                      <button
                        type="button"
                        onClick={() => setResetPassword(generatePassphrase())}
                        className="px-3 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-warm-600 dark:text-warm-200 dark:hover:bg-warm-800"
                      >
                        Generate
                      </button>
                      <button
                        onClick={() => resetUserPassword(u)}
                        disabled={busy || !resetPassword.trim()}
                        className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-100 dark:text-warm-900"
                      >
                        Set password
                      </button>
                    </div>
                    <p className="text-2xs text-gray-400 dark:text-warm-500 mt-1">
                      Takes effect immediately — share the new password with the user. No email is sent.
                      This is their shared login, so it also changes any other app they sign into with it.
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-warm-600 dark:text-warm-200 dark:hover:bg-warm-800"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(u)}
                      disabled={busy}
                      className="px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-100 dark:text-warm-900"
                    >
                      {busy ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove user access"
        message={`Remove all access for ${removeTarget?.email ?? 'this user'}? This revokes every station membership${removeTarget?.is_super_admin ? ' and super-admin' : ''}. Their account is not deleted.`}
        confirmLabel="Remove"
        confirmVariant="danger"
        onConfirm={() => removeTarget && removeUser(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  )
}
