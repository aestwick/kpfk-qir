'use client'

// Shared building blocks for the "find" views — Broadcast Day, Search, Show
// report, People — so they look and behave the same: one fetch hook (stale
// responses dropped, errors surfaced, never shown as "no results"), one status
// badge, one error panel, one highlighted-snippet renderer, one view switcher.

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { authedFetch } from '@/lib/api-client'

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface ApiState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** GET a dashboard API as the signed-in user. `url = null` means "nothing to
 *  load yet". A newer request cancels an older one, so a slow earlier query can
 *  never overwrite a newer answer. Error bodies' `error` text is surfaced. */
export function useApiJson<T>(url: string | null): ApiState<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const ctrl = useRef<AbortController | null>(null)

  useEffect(() => {
    ctrl.current?.abort()
    if (!url) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const c = new AbortController()
    ctrl.current = c
    setLoading(true)
    setError(null)
    authedFetch(url, { signal: c.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (c.signal.aborted) return
        if (!res.ok) {
          setError(body?.error ?? `Something went wrong (HTTP ${res.status}).`)
          setData(null)
        } else {
          setData(body as T)
        }
      })
      .catch((err) => {
        if (c.signal.aborted) return
        setError(err instanceof Error ? err.message : 'Network error')
        setData(null)
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false)
      })
    return () => c.abort()
  }, [url, nonce])

  return { data, error, loading, reload: () => setNonce((n) => n + 1) }
}

// ---------------------------------------------------------------------------
// Presentational
// ---------------------------------------------------------------------------

export const CARD = 'bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 shadow-card dark:shadow-card-dark'
export const INPUT =
  'border border-warm-300 rounded-lg px-3 py-2 text-sm bg-white dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100 focus:outline-none focus:ring-2 focus:ring-blue-500'
export const BUTTON =
  'px-3 py-2 text-sm rounded-lg border border-warm-300 bg-white text-warm-700 hover:bg-warm-50 disabled:opacity-50 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-200 dark:hover:bg-warm-700'

const STATUS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Waiting', cls: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-500/20 dark:text-yellow-300' },
  transcribed: { label: 'Transcribed', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-500/20 dark:text-blue-300' },
  summarized: { label: 'Summarized', cls: 'bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300' },
  compliance_checked: { label: 'Checked', cls: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300' },
  failed: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-300' },
  unavailable: { label: 'No audio', cls: 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-300' },
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-300' }
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${s.cls}`}>{s.label}</span>
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="mt-2 underline font-medium">
          Try again
        </button>
      )}
    </div>
  )
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-warm-500 dark:text-warm-400">{children}</p>
}

// The search RPCs wrap matches in private-use sentinels (U+E000/U+E001) so the
// text is HTML-escaped first and only the marks are reintroduced — a transcript
// can never inject markup. Mirrors migration 022/046.
const HL_START = ''
const HL_STOP = ''

export function Highlighted({ text, className }: { text: string | null | undefined; className?: string }) {
  if (!text) return null
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = escaped
    .split(HL_START)
    .join('<mark class="bg-yellow-200 dark:bg-yellow-500/40 rounded px-0.5">')
    .split(HL_STOP)
    .join('</mark>')
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

const VIEWS = [
  { href: '/dashboard/day', label: 'What aired', hint: 'a date & time' },
  { href: '/dashboard/search', label: 'What was said', hint: 'a quote, name or topic' },
  { href: '/dashboard/show-report', label: 'What a show covered', hint: 'a show over a period' },
  { href: '/dashboard/people', label: 'Who was on', hint: 'hosts & guests' },
]

/** Switch between the four "find" views (in-page; the sidebar is separate). */
export function FindSwitcher({ active }: { active: string }) {
  return (
    <nav aria-label="Find" className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-1">
      {VIEWS.map((v) => {
        const on = v.href === active
        return (
          <Link
            key={v.href}
            href={v.href}
            aria-current={on ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm border transition-colors ${
              on
                ? 'bg-warm-900 text-white border-warm-900 dark:bg-warm-100 dark:text-warm-900 dark:border-warm-100'
                : 'bg-white text-warm-600 border-warm-200 hover:bg-warm-50 dark:bg-warm-800 dark:text-warm-300 dark:border-warm-700'
            }`}
            title={v.hint}
          >
            {v.label}
          </Link>
        )
      })}
    </nav>
  )
}

/** A loading placeholder list. */
export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="divide-y divide-warm-100 dark:divide-warm-700" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="px-4 py-3 animate-pulse">
          <div className="h-3 w-1/3 rounded bg-warm-200 dark:bg-warm-700" />
          <div className="mt-2 h-3 w-2/3 rounded bg-warm-100 dark:bg-warm-700/60" />
        </li>
      ))}
    </ul>
  )
}
