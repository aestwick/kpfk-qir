'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { authedFetch } from '@/lib/api-client'
import { createBrowserClient } from '@/lib/supabase'
import { SkeletonTableRows } from '@/app/components/skeleton'
import { EmptyState } from '@/app/components/empty-state'
import type { AuditLogWithActor } from '@/lib/types'

// Mirrors the DB operation CHECK / lib/audit AUDIT_OPERATIONS. Kept local so this
// client page doesn't import lib/audit (which pulls in the service-role client).
const OPERATIONS = [
  'insert', 'update', 'delete', 'read', 'login', 'logout', 'export', 'login_failed', 'station_switch',
] as const

const PAGE_SIZE = 50

// Columns that, when they're the *only* thing that changed, mark a row as a
// "metadata-only update" so substantive edits stand out. Display-only.
const TIMESTAMP_FIELDS = new Set(['updated_at', 'created_at'])

interface StationOption { id: string; slug: string; name: string }

interface AuditResponse {
  rows: AuditLogWithActor[]
  page: number
  pageSize: number
  total: number
  totalUnwindowed: number
  window: { from: string; to: string | null; defaulted: boolean }
}

function defaultFrom(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function isTimestampOnly(changed: string[] | null): boolean {
  if (!changed || changed.length === 0) return false
  return changed.every((f) => TIMESTAMP_FIELDS.has(f))
}

function ActorBadge({ row }: { row: AuditLogWithActor }) {
  if (row.actor_type === 'system') {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-2xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">System</span>
  }
  if (row.actor_type === 'anonymous') {
    return <span className="inline-flex px-1.5 py-0.5 rounded text-2xs font-medium bg-warm-200 text-warm-600 dark:bg-warm-700 dark:text-warm-300">Public/Anonymous</span>
  }
  return <span className="text-warm-700 dark:text-warm-200">{row.actor_email ?? row.actor_id?.slice(0, 8) ?? 'Unknown'}</span>
}

// Render a captured value, flagging the redaction marker the DB writes for
// oversized strings so reviewers know the field held a large value, not nothing.
function Value({ v }: { v: unknown }) {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (typeof s === 'string' && /^<redacted: \d+ chars>$/.test(s)) {
    return <span className="italic text-amber-600 dark:text-amber-400" title="This field held a large value, truncated for storage size">{s} <span className="text-2xs">(truncated for size)</span></span>
  }
  return <span className="break-words">{s}</span>
}

function DiffView({ row }: { row: AuditLogWithActor }) {
  const changed = new Set(row.changed_fields ?? [])
  const keys = new Set<string>([
    ...Object.keys(row.old_data ?? {}),
    ...Object.keys(row.new_data ?? {}),
  ])
  const orderedKeys = Array.from(keys).sort((a, b) => {
    // changed fields first (excluding pure timestamps), then the rest
    const ca = changed.has(a) && !TIMESTAMP_FIELDS.has(a)
    const cb = changed.has(b) && !TIMESTAMP_FIELDS.has(b)
    if (ca !== cb) return ca ? -1 : 1
    return a.localeCompare(b)
  })

  const hasImages = row.old_data || row.new_data
  return (
    <div className="space-y-3 text-xs">
      {hasImages ? (
        <table className="w-full">
          <thead>
            <tr className="text-warm-400 dark:text-warm-500 text-left">
              <th className="font-medium py-1 pr-3">Field</th>
              <th className="font-medium py-1 pr-3">Before</th>
              <th className="font-medium py-1">After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-warm-100 dark:divide-warm-700/50 align-top">
            {orderedKeys.map((k) => {
              const isChanged = changed.has(k) && !TIMESTAMP_FIELDS.has(k)
              return (
                <tr key={k} className={isChanged ? 'bg-amber-50 dark:bg-amber-900/10' : ''}>
                  <td className="py-1 pr-3 font-mono text-warm-600 dark:text-warm-300 whitespace-nowrap">
                    {k}{isChanged && <span className="text-amber-500 ml-1">•</span>}
                  </td>
                  <td className="py-1 pr-3 text-warm-500 dark:text-warm-400 max-w-xs">
                    {row.old_data && k in row.old_data ? <Value v={row.old_data[k]} /> : <span className="text-warm-300 dark:text-warm-600">—</span>}
                  </td>
                  <td className="py-1 text-warm-700 dark:text-warm-200 max-w-xs">
                    {row.new_data && k in row.new_data ? <Value v={row.new_data[k]} /> : <span className="text-warm-300 dark:text-warm-600">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p className="text-warm-400 dark:text-warm-500 italic">No row image (read / auth / export / system event).</p>
      )}

      {row.metadata && Object.keys(row.metadata).length > 0 && (
        <div>
          <p className="text-warm-400 dark:text-warm-500 font-medium mb-1">Metadata</p>
          <pre className="bg-warm-50 dark:bg-warm-800 rounded p-2 overflow-x-auto text-2xs">{JSON.stringify(row.metadata, null, 2)}</pre>
        </div>
      )}
      <div className="flex gap-4 text-2xs text-warm-400 dark:text-warm-500">
        {row.ip_address && <span>IP: {row.ip_address}</span>}
        {row.user_agent && <span className="truncate max-w-md" title={row.user_agent}>UA: {row.user_agent}</span>}
      </div>
    </div>
  )
}

export default function AuditLogPage() {
  const [from, setFrom] = useState(defaultFrom())
  const [to, setTo] = useState('')
  const [operation, setOperation] = useState('')
  const [resourceType, setResourceType] = useState('')
  const [action, setAction] = useState('')
  const [stationId, setStationId] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)

  const [data, setData] = useState<AuditResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [stations, setStations] = useState<StationOption[]>([])

  // Stations for the filter dropdown (super-admins can read all under RLS).
  useEffect(() => {
    const supabase = createBrowserClient()
    supabase.from('stations').select('id, slug, name').order('name').then(({ data }) => {
      setStations(data ?? [])
    })
  }, [])

  const fetchAudit = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    params.set('page', String(page))
    params.set('pageSize', String(PAGE_SIZE))
    if (from) params.set('from', `${from}T00:00:00`)
    if (to) params.set('to', `${to}T23:59:59`)
    if (operation) params.set('operation', operation)
    if (resourceType) params.set('resourceType', resourceType)
    if (action) params.set('action', action)
    if (stationId) params.set('stationId', stationId)
    if (q) params.set('q', q)

    const res = await authedFetch(`/api/audit?${params}`)
    if (res.status === 403) {
      setForbidden(true)
      setLoading(false)
      return
    }
    if (res.ok) {
      setData(await res.json())
      setForbidden(false)
    }
    setLoading(false)
  }, [page, from, to, operation, resourceType, action, stationId, q])

  useEffect(() => { fetchAudit() }, [fetchAudit])

  // Any filter change resets to page 1.
  function applyFilters(setter: (v: string) => void) {
    return (v: string) => { setter(v); setPage(1) }
  }

  if (forbidden) {
    return (
      <div className="max-w-lg mx-auto mt-12">
        <EmptyState
          title="Access denied"
          description="The audit log is restricted to super-admins. If you believe you should have access, contact a system administrator."
        />
      </div>
    )
  }

  const total = data?.total ?? 0
  const totalUnwindowed = data?.totalUnwindowed ?? 0
  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1)
  const stationName = (id: string | null) => id ? (stations.find((s) => s.id === id)?.name ?? id.slice(0, 8)) : '—'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold">Audit Log</h2>
        <p className="text-sm text-warm-500 dark:text-warm-400 mt-1">
          Every user and system action across all stations. Read coverage is selective
          (episode &amp; transcript views, member list, public report views) — a missing
          read row means that view isn&apos;t instrumented, not that it never happened.
        </p>
      </div>

      {/* Trailing-window banner */}
      <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg px-4 py-3 text-sm text-blue-800 dark:text-blue-200">
        Showing recent activity{data?.window.defaulted ? ' (last 30 days)' : ''}. Full history is
        retained permanently — widen the date range to go further back.
        {' '}
        <span className="font-medium">{total.toLocaleString()}</span> in this window
        {totalUnwindowed > total && <> of <span className="font-medium">{totalUnwindowed.toLocaleString()}</span> matching all of history</>}.
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">From</span>
          <input type="date" value={from} onChange={(e) => applyFilters(setFrom)(e.target.value)} className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">To</span>
          <input type="date" value={to} onChange={(e) => applyFilters(setTo)(e.target.value)} className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">Operation</span>
          <select value={operation} onChange={(e) => applyFilters(setOperation)(e.target.value)} className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100">
            <option value="">All</option>
            {OPERATIONS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">Station</span>
          <select value={stationId} onChange={(e) => applyFilters(setStationId)(e.target.value)} className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100">
            <option value="">All</option>
            {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">Resource type</span>
          <input value={resourceType} onChange={(e) => applyFilters(setResourceType)(e.target.value)} placeholder="episode…" className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">Action</span>
          <input value={action} onChange={(e) => applyFilters(setAction)(e.target.value)} placeholder="episode.update…" className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-warm-500">Search</span>
          <input value={q} onChange={(e) => applyFilters(setQ)(e.target.value)} placeholder="action / resource…" className="border rounded px-2 py-1.5 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        </label>
      </div>

      {/* Table */}
      <div className="bg-white dark:bg-surface-raised rounded-xl border border-warm-200 dark:border-warm-700 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-warm-50 dark:bg-warm-800 border-b dark:border-warm-700 text-left">
            <tr>
              <th className="px-4 py-2.5 font-medium w-8"></th>
              <th className="px-4 py-2.5 font-medium">Time</th>
              <th className="px-4 py-2.5 font-medium">Actor</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Resource</th>
              <th className="px-4 py-2.5 font-medium">Station</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-warm-700">
            {loading ? (
              <SkeletonTableRows rows={8} />
            ) : (data?.rows.length ?? 0) === 0 ? (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-warm-400 dark:text-warm-500">No audit entries for these filters.</td></tr>
            ) : (
              data!.rows.map((row) => {
                const tsOnly = isTimestampOnly(row.changed_fields)
                const isOpen = expanded === row.id
                return (
                  <Fragment key={row.id}>
                    <tr
                      onClick={() => setExpanded(isOpen ? null : row.id)}
                      className={`cursor-pointer hover:bg-warm-50 dark:hover:bg-warm-800/50 ${tsOnly ? 'opacity-60' : ''}`}
                    >
                      <td className="px-4 py-2.5 text-warm-400">{isOpen ? '▾' : '▸'}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-warm-600 dark:text-warm-300">{fmtTime(row.created_at)}</td>
                      <td className="px-4 py-2.5"><ActorBadge row={row} /></td>
                      <td className="px-4 py-2.5">
                        <span className="font-mono text-xs">{row.action}</span>
                        {tsOnly && <span className="ml-2 text-2xs text-warm-400 dark:text-warm-500">metadata-only update</span>}
                      </td>
                      <td className="px-4 py-2.5 text-warm-600 dark:text-warm-300">
                        {row.resource_type ? <span>{row.resource_type}{row.resource_id ? ` #${row.resource_id}` : ''}</span> : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-warm-600 dark:text-warm-300">{stationName(row.station_id)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-warm-50/50 dark:bg-warm-800/30">
                        <td></td>
                        <td colSpan={5} className="px-4 py-3"><DiffView row={row} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-warm-500 dark:text-warm-400">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(p - 1, 1))}
              className="px-3 py-1.5 rounded border border-warm-200 dark:border-warm-600 disabled:opacity-40 hover:bg-warm-50 dark:hover:bg-warm-800"
            >Previous</button>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(p + 1, totalPages))}
              className="px-3 py-1.5 rounded border border-warm-200 dark:border-warm-600 disabled:opacity-40 hover:bg-warm-50 dark:hover:bg-warm-800"
            >Next</button>
          </div>
        </div>
      )}
    </div>
  )
}
