'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
import { useNavAccess } from '@/app/components/nav-access'
import { NavIconSvg } from '@/app/components/nav-icons'
import {
  visibleNav, activeNavItem, filingStatus, stationToday, reportHref, publicReportHref,
  type NavItem, type QuarterRef, type FilingStatus,
} from '@/lib/nav'

/* ─── Small session cache so the live bits (badge, deadline) don't refetch on
 *     every page load. Every navigation is a full page load today. ─── */

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw) {
      const { at, value } = JSON.parse(raw)
      if (Date.now() - at < ttlMs) return Promise.resolve(value as T)
    }
  } catch { /* storage unavailable — just load */ }
  return load().then((value) => {
    try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value })) } catch { /* ignore */ }
    return value
  })
}

/** The current location's query string, kept in sync with client navigation. */
export function useLocationSearch(): string {
  const pathname = usePathname()
  const [search, setSearch] = useState('')
  useEffect(() => {
    const read = () => setSearch(window.location.search.replace(/^\?/, ''))
    read()
    // Pages that rewrite their query in place (e.g. Settings tabs) announce it.
    window.addEventListener('qir:locationchange', read)
    window.addEventListener('popstate', read)
    return () => {
      window.removeEventListener('qir:locationchange', read)
      window.removeEventListener('popstate', read)
    }
  }, [pathname])
  return search
}

/** The menu item for the current page (respects `from` on episode pages). */
export function useActiveNavItem(): NavItem | null {
  const pathname = usePathname()
  const search = useLocationSearch()
  return activeNavItem(pathname, search)
}

/**
 * Serious (critical) flags from the current quarter that nobody has reviewed
 * yet, at the active station. These are what can hold episodes out of the QIR,
 * so it's the number worth a badge; the all-time backlog of every severity runs
 * into the thousands and would just read as noise. RLS-scoped count, no rows.
 */
function useComplianceToReview(stationId: string | undefined, today: Date | null): number | null {
  const [count, setCount] = useState<number | null>(null)
  const qStart = today ? new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1) : null
  const startIso = qStart ? isoDate(qStart) : null
  useEffect(() => {
    if (!stationId || !startIso) return
    let cancelled = false
    cached(`qir_nav_flags_${stationId}_${startIso}`, 60_000, async () => {
      const supabase = createBrowserClient()
      const { count, error } = await supabase
        .from('compliance_flags')
        .select('id, episode_log!inner(station_id, air_date)', { count: 'exact', head: true })
        .eq('review_status', 'suggested')
        .eq('severity', 'critical')
        .eq('episode_log.station_id', stationId)
        .gte('episode_log.air_date', startIso)
      return error ? null : count ?? 0
    }).then((n) => { if (!cancelled) setCount(n) }).catch(() => {})
    return () => { cancelled = true }
  }, [stationId, startIso])
  return count
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Quarters with a finalized report at the active station. */
function useFinalizedQuarters(stationId: string | undefined): QuarterRef[] | null {
  const [quarters, setQuarters] = useState<QuarterRef[] | null>(null)
  useEffect(() => {
    if (!stationId) return
    let cancelled = false
    cached(`qir_nav_final_${stationId}`, 5 * 60_000, async () => {
      const supabase = createBrowserClient()
      const { data, error } = await supabase
        .from('qir_drafts')
        .select('year, quarter')
        .eq('station_id', stationId)
        .eq('status', 'final')
      if (error) throw error
      return (data ?? []) as QuarterRef[]
    }).then((q) => { if (!cancelled) setQuarters(q) }).catch(() => {})
    return () => { cancelled = true }
  }, [stationId])
  return quarters
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDue = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`

/** "Q3 2026 report due Oct 10" — the one deadline the GM must not miss. */
function FilingChip({ status, stationSlug }: { status: FilingStatus; stationSlug: string }) {
  const tone =
    status.state === 'overdue' ? 'border-red-500/40 bg-red-500/10 text-red-200'
    : status.state === 'due' ? 'border-amber-400/40 bg-amber-400/10 text-amber-100'
    : 'border-sidebar-border text-warm-400'
  return (
    <div className={`mx-3 mb-3 rounded-lg border px-3 py-2 text-xs ${tone}`}>
      {status.state === 'finalized' ? (
        <>
          <a href={reportHref(status.next!)} className="block hover:text-warm-200">
            <span className="text-emerald-300">✓</span> {status.label} report finalized
            <span className="block text-2xs text-warm-500">Next: {status.next!.label} due {fmtDue(status.next!.due)}</span>
          </a>
          <a
            href={publicReportHref(stationSlug, status)}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-2xs text-warm-500 hover:text-warm-200 underline underline-offset-2"
          >
            Public page for the file ↗
          </a>
        </>
      ) : (
        <a href={reportHref(status)} className="block">
          <span className="font-medium">{status.label} FCC report</span>
          <span className="block text-2xs opacity-90">
            {status.state === 'overdue'
              ? `Not finalized here — was due ${fmtDue(status.due)}`
              : `Due ${fmtDue(status.due)} · not finalized yet`}
          </span>
        </a>
      )}
    </div>
  )
}

function openKey(groupId: string) {
  return `qir_nav_open_${groupId}`
}

export function SidebarNav() {
  const { role, active, loading } = useNavAccess()
  const current = useActiveNavItem()
  const today = active ? stationToday(active.timezone) : null
  const toReview = useComplianceToReview(active?.id, today)
  const finalized = useFinalizedQuarters(active?.id)
  const [opened, setOpened] = useState<Record<string, boolean>>({})
  const listRef = useRef<HTMLDivElement>(null)

  // Bring the current page's link into view (ops pages sit at the bottom).
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [current?.id, loading])

  useEffect(() => {
    const restored: Record<string, boolean> = {}
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('qir_nav_open_')) restored[k.slice('qir_nav_open_'.length)] = localStorage.getItem(k) === '1'
      }
    } catch { /* ignore */ }
    setOpened(restored)
  }, [])

  function toggle(groupId: string, isOpen: boolean) {
    setOpened((o) => ({ ...o, [groupId]: !isOpen }))
    try { localStorage.setItem(openKey(groupId), isOpen ? '0' : '1') } catch { /* ignore */ }
  }

  // Until the role is known, show the viewer menu (never flash links someone can't use).
  const groups = visibleNav(loading ? 'viewer' : role)
  const filing = finalized && today ? filingStatus(today, finalized) : null

  return (
    <div ref={listRef} className="flex-1 overflow-y-auto pb-4">
      {groups.map((group) => {
        const containsActive = !!current && group.items.some((i) => i.id === current.id)
        const isOpen = !group.collapsible || containsActive || !!opened[group.id]
        return (
          <div key={group.id} className={group.label ? 'mt-4' : ''}>
            {group.label && (
              group.collapsible ? (
                <button
                  type="button"
                  onClick={() => toggle(group.id, isOpen)}
                  aria-expanded={isOpen}
                  disabled={containsActive}
                  className="w-full flex items-center justify-between px-6 mb-1 text-2xs font-semibold uppercase tracking-wider text-warm-500 hover:text-warm-300 disabled:hover:text-warm-500"
                >
                  {group.label}
                  <svg className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                  </svg>
                </button>
              ) : (
                <p className="px-6 mb-1 text-2xs font-semibold uppercase tracking-wider text-warm-500">{group.label}</p>
              )
            )}
            {isOpen && (
              <div className="px-3 space-y-0.5">
                {group.items.map((item) => {
                  const isActive = current?.id === item.id
                  const badge = item.badge === 'complianceToReview' && toReview ? toReview : null
                  return (
                    <a
                      key={item.id}
                      href={item.href}
                      title={item.hint}
                      aria-current={isActive ? 'page' : undefined}
                      className={`nav-item ${
                        isActive
                          ? 'bg-sidebar-active text-white font-medium'
                          : 'text-warm-400 hover:bg-sidebar-hover hover:text-warm-200'
                      }`}
                    >
                      <span className={`w-5 h-5 shrink-0 ${isActive ? 'text-kpfk-gold' : 'text-warm-500'}`}>
                        <NavIconSvg name={item.icon} />
                      </span>
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.network && <span className="text-[10px] text-warm-500 shrink-0">all stations</span>}
                      {badge !== null && (
                        <span
                          className="shrink-0 min-w-[1.25rem] px-1.5 py-0.5 rounded-full bg-kpfk-red text-white text-[10px] font-semibold text-center"
                          title={`${badge} serious flag${badge === 1 ? '' : 's'} from this quarter not reviewed yet`}
                          aria-label={`${badge} serious flags from this quarter not reviewed yet`}
                        >
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </a>
                  )
                })}
              </div>
            )}
            {group.id === 'top' && filing && active && <div className="mt-3"><FilingChip status={filing} stationSlug={active.slug} /></div>}
          </div>
        )
      })}
    </div>
  )
}
