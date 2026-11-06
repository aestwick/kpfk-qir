'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { STATION_COOKIE } from '@/lib/station-cookie'
import type { NavRole } from '@/lib/nav'

/**
 * Who is signed in, which stations they can use, which one is active, and their
 * role there. Resolved once by the dashboard layout and shared with the menu,
 * the station switcher and pages that adapt to role (e.g. Shows).
 *
 * The role only decides which links to SHOW. Pages and API routes still enforce
 * access on the server — hiding a link is never the guard.
 */

export interface StationOption {
  id: string
  slug: string
  name: string
  timezone: string | null
  /** The user's role at this station; 'super' for super-admins. */
  role: NavRole
}

export interface NavAccess {
  loading: boolean
  isSuperAdmin: boolean
  stations: StationOption[]
  active: StationOption | null
  /** Role at the active station (null while loading or with no station). */
  role: NavRole | null
  /** Persist a new active station and reload so every page refetches for it. */
  switchStation: (slug: string) => Promise<void>
}

const NavAccessContext = createContext<NavAccess>({
  loading: true,
  isSuperAdmin: false,
  stations: [],
  active: null,
  role: null,
  switchStation: async () => {},
})

export function useNavAccess(): NavAccess {
  return useContext(NavAccessContext)
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name: string, value: string) {
  // 1 year, site-wide so API routes (getStationContext) can read it.
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
}

const STATION_ROLES: NavRole[] = ['viewer', 'editor', 'admin']

// The last resolved access for this user, kept for the browser tab. The menu,
// station picker and role-gated links render from it on the first paint, so
// they don't start as the viewer menu and then grow (the "menu jumps" bug).
// It's only a starting point: access is re-read from the database on every
// mount, and pages/APIs still enforce it on the server.
const accessKey = (userId: string) => `qir_nav_access_${userId}`

function readCachedAccess(userId: string): Omit<NavAccess, 'switchStation'> | null {
  try {
    const raw = sessionStorage.getItem(accessKey(userId))
    if (!raw) return null
    const { isSuperAdmin, stations } = JSON.parse(raw) as { isSuperAdmin: boolean; stations: StationOption[] }
    const cookieSlug = readCookie(STATION_COOKIE)
    const active = stations.find((o) => o.slug === cookieSlug) ?? stations[0] ?? null
    return { loading: false, isSuperAdmin, stations, active, role: active?.role ?? null }
  } catch {
    return null
  }
}

export function NavAccessProvider({ userId, children }: { userId: string; children: React.ReactNode }) {
  const [state, setState] = useState<Omit<NavAccess, 'switchStation'>>(() => readCachedAccess(userId) ?? {
    loading: true, isSuperAdmin: false, stations: [], active: null, role: null,
  })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const supabase = createBrowserClient()
      const { data: superRow } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle()
      const isSuperAdmin = !!superRow

      let stations: StationOption[] = []
      if (isSuperAdmin) {
        const { data } = await supabase.from('stations').select('id, slug, name, timezone').order('name')
        stations = (data ?? []).map((s) => ({ ...s, role: 'super' as NavRole }))
      } else {
        // RLS lets a user read their own membership rows (station_users_select).
        const { data } = await supabase
          .from('station_users')
          .select('role, stations!inner(id, slug, name, timezone)')
          .eq('user_id', userId)
        stations = (data ?? []).map((row) => {
          const s = Array.isArray(row.stations) ? row.stations[0] : row.stations
          const role = STATION_ROLES.includes(row.role as NavRole) ? (row.role as NavRole) : 'viewer'
          return { id: s.id, slug: s.slug, name: s.name, timezone: s.timezone ?? null, role }
        })
        stations.sort((a, b) => a.name.localeCompare(b.name))
      }
      if (cancelled) return

      // Resolve the active station: existing cookie if still valid, else the
      // user's first station. Persist it so the server has explicit context.
      const cookieSlug = readCookie(STATION_COOKIE)
      const active = stations.find((o) => o.slug === cookieSlug) ?? stations[0] ?? null
      if (active && active.slug !== cookieSlug) writeCookie(STATION_COOKIE, active.slug)
      try { sessionStorage.setItem(accessKey(userId), JSON.stringify({ isSuperAdmin, stations })) } catch { /* ignore */ }
      setState({ loading: false, isSuperAdmin, stations, active, role: active?.role ?? null })
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  async function switchStation(slug: string) {
    const from = state.active?.slug
    writeCookie(STATION_COOKIE, slug)
    // Audit the switch before reloading. Attach the session token and the new
    // active station so the event is attributed and station-scoped. Best-effort.
    try {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (session?.access_token) {
        await fetch('/api/audit/event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ action: 'auth.station_switch', stationSlug: slug, metadata: { from, to: slug } }),
        })
      }
    } catch {
      // Never block the switch on an audit write.
    }
    // An episode belongs to one station: after switching, its page would only
    // say "not found", so land on the Episodes list instead. Everything else
    // reloads in place for the new station.
    if (/^\/dashboard\/episodes\/[^/]+/.test(window.location.pathname)) {
      window.location.href = '/dashboard/episodes'
    } else {
      window.location.reload()
    }
  }

  return (
    <NavAccessContext.Provider value={{ ...state, switchStation }}>
      {children}
    </NavAccessContext.Provider>
  )
}
