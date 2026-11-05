'use client'

import { useNavAccess } from '@/app/components/nav-access'

/**
 * Shows which station the dashboard is acting on, and lets people with more
 * than one station switch. The choice lives in the qir_station cookie that
 * getStationContext reads (resolved by NavAccessProvider), so the server never
 * guesses a station. Single-station users still see their station's name, so
 * nobody wonders whose data they're looking at.
 */
export function StationSwitcher() {
  const { stations, active, switchStation, loading } = useNavAccess()

  // Hold the space while access loads, so the menu below doesn't jump down.
  if (!active && loading) {
    return (
      <div className="px-5 pb-4" aria-hidden="true">
        <p className="text-2xs text-warm-500 mb-1.5">Station</p>
        <div className="h-[34px] rounded-lg bg-sidebar-hover animate-pulse" />
      </div>
    )
  }
  if (!active) return null

  if (stations.length <= 1) {
    return (
      <div className="px-5 pb-4">
        <p className="text-2xs text-warm-500 mb-1">Station</p>
        <p className="text-sm text-warm-200 truncate">{active.name}</p>
      </div>
    )
  }

  return (
    <div className="px-5 pb-4">
      <label htmlFor="station-switcher" className="block text-2xs text-warm-500 mb-1.5">Station</label>
      <select
        id="station-switcher"
        value={active.slug}
        onChange={(e) => switchStation(e.target.value)}
        className="w-full bg-sidebar-hover text-warm-200 text-sm rounded-lg px-2.5 py-1.5 border border-sidebar-border focus:outline-none focus:border-kpfk-gold"
      >
        {stations.map((s) => (
          <option key={s.id} value={s.slug}>{s.name}</option>
        ))}
      </select>
    </div>
  )
}
