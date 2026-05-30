'use client'

import { useEffect, useState } from 'react'
import { createBrowserClient } from '@/lib/supabase'
import { STATION_COOKIE } from '@/lib/auth'

interface StationOption {
  id: string
  slug: string
  name: string
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]) : null
}

function writeCookie(name: string, value: string) {
  // 1 year, site-wide so API routes (getStationContext) can read it.
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
}

/**
 * Lets a user pick which station the dashboard acts on, and persists the choice
 * in the qir_station cookie that getStationContext reads. The client chooses the
 * active station here (defaulting to the user's first station on first load) so
 * the server never has to guess one. Hidden when the user has only one station.
 */
export function StationSwitcher() {
  const [stations, setStations] = useState<StationOption[]>([])
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const supabase = createBrowserClient()
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const userId = session.user.id
      const { data: superRow } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle()

      // Only stations with a configured RSS feed are selectable — an unconfigured
      // station (e.g. WBAI/New York until its rss_base_url is set) can't ingest or
      // produce a report, so hide it from the switcher. It reappears automatically
      // once rss_base_url is set.
      let opts: StationOption[] = []
      if (superRow) {
        const { data } = await supabase
          .from('stations')
          .select('id, slug, name')
          .not('rss_base_url', 'is', null)
          .order('name')
        opts = data ?? []
      } else {
        const { data } = await supabase
          .from('station_users')
          .select('stations!inner(id, slug, name)')
          .eq('user_id', userId)
          .not('stations.rss_base_url', 'is', null)
        opts = (data ?? []).map((row) => {
          const s = Array.isArray(row.stations) ? row.stations[0] : row.stations
          return { id: s.id, slug: s.slug, name: s.name }
        })
      }
      if (cancelled) return

      setStations(opts)
      if (opts.length === 0) return

      // Resolve the active station: existing cookie if still valid, else the
      // user's first station. Persist it so the server has explicit context.
      const cookieSlug = readCookie(STATION_COOKIE)
      const chosen = opts.find((o) => o.slug === cookieSlug) ?? opts[0]
      if (chosen.slug !== cookieSlug) writeCookie(STATION_COOKIE, chosen.slug)
      setActive(chosen.slug)
    }
    load()
    return () => { cancelled = true }
  }, [])

  function onChange(slug: string) {
    writeCookie(STATION_COOKIE, slug)
    setActive(slug)
    // Reload so every page refetches scoped to the newly active station.
    window.location.reload()
  }

  // Nothing to switch between — keep the chrome clean for single-station users.
  if (stations.length <= 1) return null

  return (
    <div className="px-5 pb-4">
      <label className="block text-2xs text-warm-500 mb-1.5">Station</label>
      <select
        value={active ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-sidebar-hover text-warm-200 text-sm rounded-lg px-2.5 py-1.5 border border-sidebar-border focus:outline-none focus:border-kpfk-gold"
      >
        {stations.map((s) => (
          <option key={s.id} value={s.slug}>{s.name}</option>
        ))}
      </select>
    </div>
  )
}
