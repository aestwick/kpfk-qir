'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { authedFetch } from '@/lib/api-client'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { SkeletonCards, SkeletonTableRows } from '@/app/components/skeleton'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { withFrom, locationFrom } from '@/lib/nav'
import { useToast } from '@/app/components/toast'
import { DAY_NAMES_SHORT } from '@/lib/compliance-grid'
import { REVIEW_STATUS_LABELS, REVIEW_STATUS_BADGE, type ReviewStatus } from '@/lib/compliance-status'
import { getQuarterOptions as getQuarterRange } from '@/lib/quarters'

interface ComplianceFlag {
  id: number
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
  review_status: ReviewStatus
  resolved_by: string | null
  resolved_notes: string | null
  created_at: string
  episode_log: {
    show_name: string | null
    show_key: string
    air_date: string | null
    headline: string | null
  }
}

interface ComplianceWord {
  id: number
  word: string
  severity: string
  active: boolean
  station_id: string | null   // null = global base term (applies to every station)
}

interface ShowHealth {
  show_key: string
  show_name: string
  episodes_checked: number
  episodes_clean: number
  episodes_flagged: number
  total_flags: number
  critical: number
  warning: number
  info: number
  by_type: Record<string, number>
  score: number
}

interface Stats {
  byType: Record<string, number>
  bySeverity: Record<string, number>
  total: number
  pendingTriage: number
}

// Status filter options for the list. 'active' is a UI convenience that maps
// to investigating + violation on the API.
const STATUS_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'suggested', label: 'Suggested (to review)' },
  { value: 'active', label: 'Active (Investigating + Violation)' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'violation', label: 'Violation' },
  { value: 'dismissed', label: 'Dismissed' },
]

// Status transitions offered as quick actions, given the flag's current status.
const STATUS_ACTIONS: ReviewStatus[] = ['investigating', 'violation', 'dismissed', 'suggested']

const FLAG_TYPES = ['profanity', 'station_id_missing', 'technical', 'payola_plugola', 'sponsor_id', 'indecency'] as const
const SEVERITIES = ['info', 'warning', 'critical']

// Quarter filter options. Value is `YYYY-Q` (split on `-` below into year/quarter
// for the API). Sourced from the shared helper so no future quarter is ever shown.
function getQuarterOptions(): { label: string; value: string }[] {
  return getQuarterRange(1).map((o) => ({ label: o.label, value: `${o.year}-${o.quarter}` }))
}

const severityColors: Record<string, string> = {
  info: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
}

const typeLabels: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Station ID Missing',
  technical: 'Technical',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID',
  indecency: 'Indecency',
}

function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return '--'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 'HH:MM:SS' → '6 AM', '12:30 PM'. Used to label a grid drill-through slot.
function formatSlot(airStart: string): string {
  const [h, m] = airStart.split(':').map((p) => parseInt(p, 10))
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')} ${period}`
}

// Human label for a day/time drill-through chip, e.g. "Mon 6–7 AM".
function slotLabel(dow: string, airStart: string): string {
  const day = DAY_NAMES_SHORT[parseInt(dow)] ?? '?'
  const slots = airStart.split(',').map((s) => s.trim()).filter(Boolean)
  if (slots.length <= 1) return `${day} ${formatSlot(slots[0] ?? airStart)}`
  return `${day} ${formatSlot(slots[0])}–${formatSlot(slots[slots.length - 1])}`
}

export default function CompliancePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const { toast } = useToast()

  // Filters from URL
  const [filterType, setFilterType] = useState(searchParams.get('type') ?? '')
  const [filterSeverity, setFilterSeverity] = useState(searchParams.get('severity') ?? '')
  // Default to the triage inbox (untriaged AI suggestions) — that's where the
  // review work is. An empty status= param from the grid drill means "all".
  const [filterStatus, setFilterStatus] = useState(searchParams.get('status') ?? 'suggested')
  const [filterQuarter, setFilterQuarter] = useState(searchParams.get('quarter') ?? '')
  const [filterShow, setFilterShow] = useState(searchParams.get('show') ?? '')
  // Day/time drill-through from the compliance grid (set via URL params). Not an
  // editable control — shown as a removable chip; cleared, it stays cleared.
  const [slotFilter, setSlotFilter] = useState<{
    dow: string; airStart: string; winStart: string; winEnd: string
  } | null>(() => {
    const dow = searchParams.get('dow')
    const airStart = searchParams.get('air_start')
    const winStart = searchParams.get('win_start')
    const winEnd = searchParams.get('win_end')
    return dow && airStart && winStart && winEnd ? { dow, airStart, winStart, winEnd } : null
  })
  const [page, setPage] = useState(parseInt(searchParams.get('page') ?? '1'))

  // Data
  const [flags, setFlags] = useState<ComplianceFlag[]>([])
  const [stats, setStats] = useState<Stats>({ byType: {}, bySeverity: {}, total: 0, pendingTriage: 0 })
  const [showHealth, setShowHealth] = useState<ShowHealth[]>([])
  const [showHealthExpanded, setShowHealthExpanded] = useState(false)
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 })
  const [words, setWords] = useState<ComplianceWord[]>([])
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  // Selection for bulk resolve
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Status-change UI. statusTarget tracks which flag is being given which
  // status while the reviewer types a note inline.
  const [statusTarget, setStatusTarget] = useState<{ id: number; status: ReviewStatus } | null>(null)
  const [resolveNotes, setResolveNotes] = useState('')
  const [bulkStatus, setBulkStatus] = useState<ReviewStatus | null>(null)
  const [bulkNotes, setBulkNotes] = useState('')

  // Loading states for actions
  const [actionLoading, setActionLoading] = useState(false)
  const [processingShow, setProcessingShow] = useState<string | null>(null)

  // Tab for rules section
  const [rulesTab, setRulesTab] = useState<'wordlist' | 'prompt' | 'checks'>('wordlist')

  // Wordlist form
  const [newWord, setNewWord] = useState('')
  const [newWordSeverity, setNewWordSeverity] = useState('critical')
  const [addingWord, setAddingWord] = useState(false)
  const [editingWord, setEditingWord] = useState<number | null>(null)
  const [editWordSeverity, setEditWordSeverity] = useState('')

  // Compliance prompt
  const [compliancePrompt, setCompliancePrompt] = useState('')
  const [promptDirty, setPromptDirty] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)

  // Check toggles — per-flag-type map matching DB schema
  const [checkToggles, setCheckToggles] = useState<Record<string, boolean>>({
    profanity: true, station_id_missing: true, technical: true, payola_plugola: true, sponsor_id: true, indecency: true,
  })
  const [blocking, setBlocking] = useState(false)
  // Centralized compliance config (prompt, checks default, blocking, global
  // wordlist) is super-admin-only; station staff see it read-only.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [newWordGlobal, setNewWordGlobal] = useState(false)

  // Confirm dialog
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean
    title: string
    message: string
    variant: 'danger' | 'primary'
    onConfirm: () => void
  }>({ open: false, title: '', message: '', variant: 'primary', onConfirm: () => {} })

  // Prevent duplicate initial fetches
  const initialLoadDone = useRef(false)

  // Build API query params for flags list
  const buildApiParams = useCallback(() => {
    const params = new URLSearchParams()
    if (filterType) params.set('flag_type', filterType)
    if (filterSeverity) params.set('severity', filterSeverity)
    if (filterStatus === 'active') params.set('status', 'investigating,violation')
    else if (filterStatus) params.set('status', filterStatus)
    if (filterQuarter) {
      const [y, q] = filterQuarter.split('-')
      params.set('year', y)
      params.set('quarter', q)
    }
    if (filterShow) params.set('show', filterShow)
    if (slotFilter) {
      params.set('dow', slotFilter.dow)
      params.set('air_start', slotFilter.airStart)
      params.set('win_start', slotFilter.winStart)
      params.set('win_end', slotFilter.winEnd)
    }
    if (page > 1) params.set('page', String(page))
    params.set('sort', 'created_at')
    params.set('dir', 'desc')
    return params
  }, [filterType, filterSeverity, filterStatus, filterQuarter, filterShow, slotFilter, page])

  // Fetch flags list
  const fetchFlags = useCallback(async () => {
    try {
      const params = buildApiParams()
      const res = await authedFetch(`/api/compliance?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setFlags(data.flags ?? [])
      setPagination(data.pagination ?? { page: 1, limit: 50, total: 0, totalPages: 0 })
    } catch (err) {
      console.error('Failed to fetch flags:', err)
      toast('error', 'Failed to load compliance flags')
    }
  }, [buildApiParams, toast])

  // Fetch stats (total unresolved counts across all pages)
  const fetchStats = useCallback(async () => {
    try {
      const res = await authedFetch('/api/compliance?stats=true')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStats(data.stats ?? { byType: {}, bySeverity: {}, total: 0, pendingTriage: 0 })
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    }
  }, [])

  // Initial load — fetch everything in parallel
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    setLoading(true)
    Promise.all([
      fetchFlags(),
      fetchStats(),
      authedFetch('/api/compliance/wordlist').then((r) => r.ok ? r.json() : { words: [] }),
      authedFetch('/api/settings').then((r) => r.ok ? r.json() : { settings: {} }),
      authedFetch('/api/compliance?by_show=true').then((r) => r.ok ? r.json() : { shows: [] }),
    ]).then(([, , wordData, settingsData, showData]) => {
      setShowHealth(showData.shows ?? [])
      setWords(wordData.words ?? [])
      setIsSuperAdmin(wordData.isSuperAdmin === true)
      const s = settingsData.settings ?? {}
      setSettings(s)
      setCompliancePrompt((s.compliance_prompt as string) ?? '')
      // compliance_checks_enabled is a JSON object: { profanity: true, station_id_missing: true, ... }
      if (s.compliance_checks_enabled && typeof s.compliance_checks_enabled === 'object') {
        setCheckToggles(s.compliance_checks_enabled as Record<string, boolean>)
      }
      setBlocking(s.compliance_blocking === 'true' || s.compliance_blocking === true)
      setLoading(false)
    })
  }, [fetchFlags, fetchStats])

  // Update URL when filters change
  useEffect(() => {
    const params = new URLSearchParams()
    if (filterType) params.set('type', filterType)
    if (filterSeverity) params.set('severity', filterSeverity)
    if (filterStatus) params.set('status', filterStatus)
    if (filterQuarter) params.set('quarter', filterQuarter)
    if (filterShow) params.set('show', filterShow)
    if (slotFilter) {
      params.set('dow', slotFilter.dow)
      params.set('air_start', slotFilter.airStart)
      params.set('win_start', slotFilter.winStart)
      params.set('win_end', slotFilter.winEnd)
    }
    if (page > 1) params.set('page', String(page))
    const qs = params.toString()
    router.replace(`/dashboard/compliance${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [filterType, filterSeverity, filterStatus, filterQuarter, filterShow, slotFilter, page, router])

  // Refetch flags when filters/page change (skip initial render)
  const filterChangeCount = useRef(0)
  useEffect(() => {
    // Skip the first render (initial load already fetched)
    if (filterChangeCount.current === 0) {
      filterChangeCount.current++
      return
    }
    filterChangeCount.current++
    fetchFlags()
  }, [fetchFlags])

  // Preserve scroll position across navigation (e.g. opening an episode and
  // coming back). Keyed by the active filter query so a different filter view
  // doesn't inherit a stale position. Persisted to sessionStorage as the user
  // scrolls, and restored once the list has rendered on the next mount.
  const scrollKey = `compliance-scroll:${searchParams.toString()}`
  useEffect(() => {
    const onScroll = () => {
      try { sessionStorage.setItem(scrollKey, String(window.scrollY)) } catch { /* ignore */ }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [scrollKey])

  useEffect(() => {
    if (loading) return
    let saved: string | null = null
    try { saved = sessionStorage.getItem(scrollKey) } catch { /* ignore */ }
    if (saved) {
      // Wait for the freshly-loaded rows to paint before restoring.
      requestAnimationFrame(() => window.scrollTo(0, parseInt(saved!, 10)))
    }
    // Restore once, after the initial load completes for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  // Toggle selection
  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === flags.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(flags.map((f) => f.id)))
    }
  }

  // Revert a single flag back to a prior status (used by the toast Undo).
  async function undoFlagStatus(id: number, prevStatus: ReviewStatus) {
    try {
      const res = await authedFetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, review_status: prevStatus, resolved_by: 'dashboard' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast('success', `Reverted to ${REVIEW_STATUS_LABELS[prevStatus]}`)
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to undo flag status:', err)
      toast('error', 'Failed to undo')
    }
  }

  // Revert a bulk status change. The API sets one status per call, so the prior
  // statuses are grouped and reverted in batches.
  async function undoBulkStatus(prevById: Map<number, ReviewStatus>) {
    const byStatus = new Map<ReviewStatus, number[]>()
    prevById.forEach((st, id) => {
      const arr = byStatus.get(st) ?? []
      arr.push(id)
      byStatus.set(st, arr)
    })
    try {
      for (const [st, ids] of Array.from(byStatus.entries())) {
        const res = await authedFetch('/api/compliance', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, review_status: st, resolved_by: 'dashboard' }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      }
      toast('success', `Reverted ${prevById.size} flag${prevById.size > 1 ? 's' : ''}`)
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to undo bulk update:', err)
      toast('error', 'Failed to undo')
    }
  }

  // Set a single flag's review status
  async function setFlagStatus(id: number, status: ReviewStatus, notes: string) {
    if (actionLoading) return
    // Capture the prior status so the action can be undone from the toast.
    const prevStatus = flags.find((f) => f.id === id)?.review_status
    setActionLoading(true)
    try {
      const res = await authedFetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, review_status: status, resolved_notes: notes, resolved_by: 'dashboard' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast(
        'success',
        `Marked ${REVIEW_STATUS_LABELS[status]}`,
        prevStatus && prevStatus !== status
          ? { label: 'Undo', onClick: () => undoFlagStatus(id, prevStatus) }
          : undefined,
      )
      setStatusTarget(null)
      setResolveNotes('')
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to update flag status:', err)
      toast('error', 'Failed to update flag')
    } finally {
      setActionLoading(false)
    }
  }

  // Bulk-set the review status of the selected flags
  async function bulkSetStatus(status: ReviewStatus) {
    if (actionLoading) return
    setActionLoading(true)
    try {
      const ids = Array.from(selected)
      // Snapshot prior statuses so the bulk change can be undone from the toast.
      const prevById = new Map<number, ReviewStatus>(
        flags.filter((f) => selected.has(f.id)).map((f) => [f.id, f.review_status]),
      )
      const res = await authedFetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, review_status: status, resolved_notes: bulkNotes, resolved_by: 'dashboard' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast(
        'success',
        `Marked ${ids.length} flag${ids.length > 1 ? 's' : ''} ${REVIEW_STATUS_LABELS[status]}`,
        prevById.size > 0
          ? { label: 'Undo', onClick: () => undoBulkStatus(prevById) }
          : undefined,
      )
      setSelected(new Set())
      setBulkStatus(null)
      setBulkNotes('')
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to bulk update:', err)
      toast('error', 'Failed to update flags')
    } finally {
      setActionLoading(false)
    }
  }

  // Add word
  async function addWord() {
    if (!newWord.trim() || addingWord) return
    setAddingWord(true)
    try {
      const res = await authedFetch('/api/compliance/wordlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: newWord.trim(), severity: newWordSeverity, scope: newWordGlobal ? 'global' : 'station' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNewWord('')
      const listRes = await authedFetch('/api/compliance/wordlist')
      if (listRes.ok) {
        const data = await listRes.json()
        setWords(data.words ?? [])
      }
      toast('success', 'Word added')
    } catch (err) {
      console.error('Failed to add word:', err)
      toast('error', 'Failed to add word')
    } finally {
      setAddingWord(false)
    }
  }

  // Delete word
  async function deleteWord(id: number) {
    try {
      const res = await authedFetch(`/api/compliance/wordlist?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setWords((prev) => prev.filter((w) => w.id !== id))
      toast('success', 'Word removed')
    } catch (err) {
      console.error('Failed to delete word:', err)
      toast('error', 'Failed to remove word')
    }
  }

  // Edit word severity
  async function saveWordEdit(id: number) {
    try {
      const res = await authedFetch('/api/compliance/wordlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, severity: editWordSeverity }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setWords((prev) => prev.map((w) => w.id === id ? { ...w, severity: editWordSeverity } : w))
      setEditingWord(null)
      toast('success', 'Word updated')
    } catch (err) {
      console.error('Failed to edit word:', err)
      toast('error', 'Failed to update word')
    }
  }

  // Save compliance prompt
  async function savePrompt() {
    if (savingPrompt) return
    setSavingPrompt(true)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_prompt', value: compliancePrompt, scope: 'global' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setPromptDirty(false)
      toast('success', 'Prompt saved')
    } catch (err) {
      console.error('Failed to save prompt:', err)
      toast('error', 'Failed to save prompt')
    } finally {
      setSavingPrompt(false)
    }
  }

  // Toggle individual check type
  async function toggleCheckType(type: string, enabled: boolean) {
    const updated = { ...checkToggles, [type]: enabled }
    setCheckToggles(updated)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Super-admin edits the central default (global); a station admin sets a
        // local override. Checks are "managed centrally, overridable locally".
        body: JSON.stringify({ key: 'compliance_checks_enabled', value: updated, ...(isSuperAdmin ? { scope: 'global' } : {}) }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.error('Failed to toggle check:', err)
      setCheckToggles({ ...checkToggles, [type]: !enabled }) // revert on error
      toast('error', 'Failed to update setting')
    }
  }

  async function toggleBlocking(b: boolean) {
    setBlocking(b)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_blocking', value: String(b), scope: 'global' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (err) {
      console.error('Failed to toggle blocking:', err)
      setBlocking(!b) // revert on error
      toast('error', 'Failed to update setting')
    }
  }

  async function runComplianceForShow(showKey: string, showName: string) {
    if (processingShow) return
    setProcessingShow(showKey)
    try {
      const res = await authedFetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'compliance', show_key: showKey }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      toast('success', data.message ?? `Compliance check queued for ${showName}`)
    } catch (err) {
      console.error('Failed to queue compliance check:', err)
      toast('error', `Failed to queue compliance check for ${showName}`)
    } finally {
      setProcessingShow(null)
    }
  }

  // Build URL for the public compliance report page with current filters
  function buildReportUrl(): string {
    const params = new URLSearchParams()
    // The public compliance-report page is station-scoped via this slug
    // (read from the qir_station cookie set by the station switcher).
    const stationSlug = document.cookie.match(/(?:^|; )qir_station=([^;]*)/)?.[1]
    if (stationSlug) params.set('station', decodeURIComponent(stationSlug))
    if (filterType) params.set('type', filterType)
    if (filterSeverity) params.set('severity', filterSeverity)
    // The public report distinguishes active-offenses-only vs. everything.
    const activeViews = ['active', 'investigating', 'violation']
    params.set('unresolved', activeViews.includes(filterStatus) ? 'true' : 'false')
    if (filterQuarter) params.set('quarter', filterQuarter)
    if (filterShow) params.set('show', filterShow)
    return params.toString()
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Breadcrumbs />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-warm-100">Compliance</h1>
        <SkeletonCards count={5} />
        <div className="bg-white rounded-xl shadow-sm border overflow-hidden dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
          <table className="w-full">
            <tbody>
              <SkeletonTableRows rows={8} />
            </tbody>
          </table>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs />
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-warm-100">Compliance</h1>
        <div className="flex items-center gap-2">
          <a
            href="/dashboard/compliance/grid"
            title="Open the offense-density grid — a heatmap of flags by show and day"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50 dark:bg-surface-raised dark:text-warm-200 dark:border-warm-600 dark:hover:bg-warm-700/50"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            Grid
          </a>
          <a
            href={`/compliance-report?${buildReportUrl()}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Open a print-ready compliance report for the current filters (new tab)"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-700 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
            </svg>
            View Report
            <svg className="w-3.5 h-3.5 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5m0-5L10 14M19 14v5a1 1 0 01-1 1H6a1 1 0 01-1-1V7a1 1 0 011-1h5" />
            </svg>
          </a>
        </div>
      </div>

      {/* Triage inbox callout — raw AI suggestions awaiting review */}
      {stats.pendingTriage > 0 && (
        <button
          onClick={() => { setFilterStatus('suggested'); setPage(1) }}
          className="w-full text-left bg-gray-50 border rounded-xl px-4 py-3 flex items-center justify-between hover:bg-gray-100 dark:bg-warm-800 dark:border-warm-700 dark:hover:bg-warm-700/50"
        >
          <span className="text-sm text-gray-700 dark:text-warm-200">
            <span className="font-semibold">{stats.pendingTriage}</span> suggested flag{stats.pendingTriage !== 1 ? 's' : ''} awaiting review
          </span>
          <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">Review &rarr;</span>
        </button>
      )}

      {/* Summary Stats Strip — active offenses (investigating + violation) by type */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {FLAG_TYPES.map((type) => (
          <div key={type} className="bg-white rounded-xl shadow-sm border p-3 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide dark:text-warm-500">{typeLabels[type]}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 dark:text-warm-100">{stats.byType[type] ?? 0}</p>
            <p className="text-xs text-gray-500 dark:text-warm-400">active</p>
          </div>
        ))}
      </div>

      {/* Show Health Summary */}
      {showHealth.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
          <button
            onClick={() => setShowHealthExpanded(!showHealthExpanded)}
            className="w-full px-5 py-4 flex items-center justify-between text-left"
          >
            <div>
              <h3 className="text-sm font-semibold text-gray-900 dark:text-warm-100">Show Health</h3>
              <p className="text-xs text-gray-500 mt-0.5 dark:text-warm-400">
                {showHealth.filter((s) => s.score === 100).length} clean / {showHealth.length} shows checked
              </p>
            </div>
            <svg className={`w-5 h-5 text-gray-400 dark:text-warm-500 transition-transform ${showHealthExpanded ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showHealthExpanded && (
            <div className="border-t overflow-x-auto dark:border-warm-700">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
                  <tr>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Show</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Score</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Checked</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Clean</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Flagged</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Critical</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Warning</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Total Flags</th>
                    <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-warm-700">
                  {showHealth.map((show) => (
                    <tr
                      key={show.show_key}
                      className="hover:bg-gray-50 dark:hover:bg-warm-700/50 cursor-pointer"
                      onClick={() => { setFilterShow(show.show_name); setPage(1) }}
                    >
                      <td className="px-4 py-2.5 font-medium text-gray-900 dark:text-warm-100 max-w-[200px] truncate">
                        {show.show_name}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${
                          show.score === 100
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                            : show.score >= 80
                              ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        }`}>
                          {show.score}%
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-600 dark:text-warm-400">{show.episodes_checked}</td>
                      <td className="px-4 py-2.5 text-center text-green-600 dark:text-green-400 font-medium">{show.episodes_clean}</td>
                      <td className="px-4 py-2.5 text-center text-amber-600 dark:text-amber-400 font-medium">{show.episodes_flagged || '—'}</td>
                      <td className="px-4 py-2.5 text-center">
                        {show.critical > 0
                          ? <span className="text-red-600 dark:text-red-400 font-bold">{show.critical}</span>
                          : <span className="text-gray-300 dark:text-warm-600">—</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        {show.warning > 0
                          ? <span className="text-amber-600 dark:text-amber-400 font-medium">{show.warning}</span>
                          : <span className="text-gray-300 dark:text-warm-600">—</span>
                        }
                      </td>
                      <td className="px-4 py-2.5 text-center text-gray-600 dark:text-warm-400">{show.total_flags || '—'}</td>
                      <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => runComplianceForShow(show.show_key, show.show_name)}
                          disabled={processingShow !== null}
                          className="text-xs px-2.5 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap dark:bg-blue-700 dark:hover:bg-blue-600"
                          title={`Run compliance checks on all episodes of ${show.show_name}`}
                        >
                          {processingShow === show.show_key ? 'Queuing...' : 'Run Check'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl shadow-sm border p-4 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Type</label>
            <select
              value={filterType}
              onChange={(e) => { setFilterType(e.target.value); setPage(1) }}
              className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="">All Types</option>
              {FLAG_TYPES.map((t) => (
                <option key={t} value={t}>{typeLabels[t]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Severity</label>
            <select
              value={filterSeverity}
              onChange={(e) => { setFilterSeverity(e.target.value); setPage(1) }}
              className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="">All</option>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Status</label>
            <select
              value={filterStatus}
              onChange={(e) => { setFilterStatus(e.target.value); setPage(1) }}
              className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              {STATUS_FILTER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Quarter</label>
            <select
              value={filterQuarter}
              onChange={(e) => { setFilterQuarter(e.target.value); setPage(1) }}
              className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="">All Quarters</option>
              {getQuarterOptions().map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Show</label>
            <input
              type="text"
              value={filterShow}
              onChange={(e) => { setFilterShow(e.target.value); setPage(1) }}
              placeholder="Search show..."
              className="border rounded-lg px-3 py-1.5 text-sm w-48 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            />
          </div>
          {slotFilter && (
            <div className="flex items-end">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-kpfk-red/10 text-kpfk-red-dark border border-kpfk-red/30 dark:text-kpfk-red-light">
                Grid: {slotLabel(slotFilter.dow, slotFilter.airStart)}
                <button
                  onClick={() => { setSlotFilter(null); setPage(1) }}
                  className="hover:text-kpfk-red"
                  aria-label="Clear day/time filter"
                >
                  ✕
                </button>
              </span>
            </div>
          )}
          {(filterType || filterSeverity || filterStatus || filterQuarter || filterShow || slotFilter) && (
            <button
              onClick={() => { setFilterType(''); setFilterSeverity(''); setFilterStatus(''); setFilterQuarter(''); setFilterShow(''); setSlotFilter(null); setPage(1) }}
              className="text-xs text-gray-500 hover:text-gray-700 underline dark:text-warm-400 dark:hover:text-warm-200"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex flex-wrap items-center justify-between gap-2 dark:bg-blue-900/20 dark:border-blue-800/40">
          <span className="text-sm text-blue-800 font-medium dark:text-blue-300">{selected.size} flag{selected.size > 1 ? 's' : ''} selected</span>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => { setBulkStatus('investigating'); setBulkNotes('') }}
              disabled={actionLoading}
              className="px-3 py-1.5 text-sm font-medium bg-amber-500 text-white rounded-lg hover:bg-amber-600 disabled:opacity-50"
            >
              Investigating
            </button>
            <button
              onClick={() => { setBulkStatus('violation'); setBulkNotes('') }}
              disabled={actionLoading}
              className="px-3 py-1.5 text-sm font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
            >
              Violation
            </button>
            <button
              onClick={() => { setBulkStatus('dismissed'); setBulkNotes('') }}
              disabled={actionLoading}
              className="px-3 py-1.5 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              Dismiss
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="px-3 py-1.5 text-sm font-medium text-gray-600 bg-white border rounded-lg hover:bg-gray-50 dark:bg-warm-800 dark:text-warm-300 dark:border-warm-600 dark:hover:bg-warm-700/50"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Bulk status-change notes dialog */}
      {bulkStatus && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBulkStatus(null)} />
          <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6 dark:bg-surface-raised dark:shadow-card-dark">
            <h3 className="text-lg font-semibold text-gray-900 mb-2 dark:text-warm-100">
              Mark {selected.size} flag{selected.size > 1 ? 's' : ''} as {REVIEW_STATUS_LABELS[bulkStatus]}
            </h3>
            <textarea
              value={bulkNotes}
              onChange={(e) => setBulkNotes(e.target.value)}
              placeholder="Review notes (optional)..."
              className="w-full border rounded-lg p-3 text-sm mb-4 h-24 resize-none dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setBulkStatus(null)}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 dark:bg-warm-700 dark:text-warm-200 dark:hover:bg-warm-600"
              >
                Cancel
              </button>
              <button
                onClick={() => bulkSetStatus(bulkStatus)}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
              >
                {actionLoading ? 'Saving...' : `Mark ${REVIEW_STATUS_LABELS[bulkStatus]}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Flags Table */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
              <tr>
                <th className="px-4 py-3 text-left">
                  <input
                    type="checkbox"
                    checked={flags.length > 0 && selected.size === flags.length}
                    onChange={toggleSelectAll}
                    className="rounded"
                  />
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Episode</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Severity</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Excerpt</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Time</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-warm-700">
              {flags.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400 dark:text-warm-500">
                    No compliance flags found
                  </td>
                </tr>
              ) : (
                flags.map((flag) => {
                  // Thread the current location (path + active filters) so the
                  // episode page's breadcrumb/back link return here — to
                  // Compliance with these filters — instead of the Episodes list.
                  const from = locationFrom(pathname, searchParams.toString())
                  const episodeUrl = withFrom(
                    `/dashboard/episodes/${flag.episode_id}${flag.timestamp_seconds != null ? `?seek=${flag.timestamp_seconds}` : ''}`,
                    from,
                  )
                  return (
                  <tr
                    key={flag.id}
                    className={`hover:bg-gray-50 dark:hover:bg-warm-700/50 cursor-pointer ${selected.has(flag.id) ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
                    onClick={() => router.push(episodeUrl)}
                  >
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(flag.id)}
                        onChange={() => toggleSelect(flag.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={episodeUrl}
                        onClick={(e) => e.stopPropagation()}
                        className="text-blue-600 hover:underline font-medium"
                      >
                        {flag.episode_log?.show_name ?? `Episode #${flag.episode_id}`}
                      </a>
                      {flag.episode_log?.air_date && (
                        <p className="text-xs text-gray-400 dark:text-warm-500">{flag.episode_log.air_date}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700 dark:bg-warm-700 dark:text-warm-300">
                        {typeLabels[flag.flag_type] ?? flag.flag_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${severityColors[flag.severity] ?? 'bg-gray-100 text-gray-700'}`}>
                        {flag.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-xs truncate text-gray-600 dark:text-warm-400" title={flag.excerpt ?? ''}>
                      {flag.excerpt ?? '--'}
                    </td>
                    <td className="px-4 py-3">
                      {flag.timestamp_seconds != null ? (
                        <a
                          href={episodeUrl}
                          onClick={(e) => e.stopPropagation()}
                          className="text-blue-600 hover:underline font-mono text-xs"
                        >
                          {formatTimestamp(flag.timestamp_seconds)}
                        </a>
                      ) : (
                        <span className="text-gray-400 dark:text-warm-500">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${REVIEW_STATUS_BADGE[flag.review_status]}`}>
                        {REVIEW_STATUS_LABELS[flag.review_status]}
                      </span>
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {statusTarget?.id === flag.id ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={resolveNotes}
                            onChange={(e) => setResolveNotes(e.target.value)}
                            placeholder="Notes (optional)..."
                            className="border rounded px-2 py-1 text-xs w-32 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setFlagStatus(flag.id, statusTarget.status, resolveNotes)
                              if (e.key === 'Escape') { setStatusTarget(null); setResolveNotes('') }
                            }}
                          />
                          <button
                            onClick={() => setFlagStatus(flag.id, statusTarget.status, resolveNotes)}
                            disabled={actionLoading}
                            className="text-xs text-green-600 hover:text-green-800 font-medium disabled:opacity-50 whitespace-nowrap"
                          >
                            {actionLoading ? '...' : `Save: ${REVIEW_STATUS_LABELS[statusTarget.status]}`}
                          </button>
                          <button
                            onClick={() => { setStatusTarget(null); setResolveNotes('') }}
                            className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-500 dark:hover:text-warm-300"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          {STATUS_ACTIONS.filter((s) => s !== flag.review_status).map((s) => (
                            <button
                              key={s}
                              onClick={() => { setStatusTarget({ id: flag.id, status: s }); setResolveNotes('') }}
                              className="text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
                            >
                              {s === 'suggested' ? 'Reset' : REVIEW_STATUS_LABELS[s]}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="border-t px-4 py-3 flex items-center justify-between text-sm text-gray-600 dark:border-warm-700 dark:text-warm-400">
            <span>
              Showing {((pagination.page - 1) * pagination.limit) + 1}&ndash;{Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}
            </span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-50 dark:border-warm-600 dark:hover:bg-warm-700/50"
              >
                Prev
              </button>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-3 py-1 rounded border disabled:opacity-50 hover:bg-gray-50 dark:border-warm-600 dark:hover:bg-warm-700/50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Compliance Rules Section */}
      <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
        <div className="border-b dark:border-warm-700">
          <div className="flex">
            {(['wordlist', 'prompt', 'checks'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setRulesTab(tab)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                  rulesTab === tab
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-200'
                }`}
              >
                {tab === 'wordlist' ? 'Profanity Word List' : tab === 'prompt' ? 'AI Compliance Prompt' : 'Check Settings'}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5">
          {/* Wordlist Tab */}
          {rulesTab === 'wordlist' && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newWord}
                  onChange={(e) => setNewWord(e.target.value)}
                  placeholder="Add word..."
                  className="border rounded-lg px-3 py-1.5 text-sm flex-1 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                  onKeyDown={(e) => e.key === 'Enter' && addWord()}
                />
                <select
                  value={newWordSeverity}
                  onChange={(e) => setNewWordSeverity(e.target.value)}
                  className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                >
                  <option value="warning">Warning</option>
                  <option value="critical">Critical</option>
                </select>
                <button
                  onClick={addWord}
                  disabled={addingWord || !newWord.trim()}
                  className="px-4 py-1.5 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-700 disabled:opacity-50 dark:bg-warm-700 dark:hover:bg-warm-600"
                >
                  {addingWord ? 'Adding...' : 'Add'}
                </button>
              </div>
              {isSuperAdmin && (
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-warm-300 -mt-2">
                  <input type="checkbox" checked={newWordGlobal} onChange={(e) => setNewWordGlobal(e.target.checked)} />
                  Add to the <strong>global base</strong> list (applies to every station)
                </label>
              )}
              <p className="text-xs text-gray-400 dark:text-warm-500">
                <span className="px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">global</span> terms are the shared FCC base (super-admin managed); the rest are this station&apos;s own additions.
              </p>
              <div className="divide-y dark:divide-warm-700 max-h-80 overflow-y-auto">
                {words.map((w) => {
                  // Station staff may edit their own additions but not the global base.
                  const canEdit = isSuperAdmin || w.station_id !== null
                  return (
                  <div key={w.id} className="flex items-center justify-between py-2 px-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono dark:text-warm-100">{w.word}</span>
                      {w.station_id === null && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">global</span>
                      )}
                      {!canEdit ? (
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${severityColors[w.severity]}`}>{w.severity}</span>
                      ) : editingWord === w.id ? (
                        <div className="flex items-center gap-1">
                          <select
                            value={editWordSeverity}
                            onChange={(e) => setEditWordSeverity(e.target.value)}
                            className="border rounded px-1.5 py-0.5 text-xs dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                            autoFocus
                          >
                            <option value="warning">warning</option>
                            <option value="critical">critical</option>
                          </select>
                          <button onClick={() => saveWordEdit(w.id)} className="text-xs text-green-600 hover:text-green-800 dark:text-green-400 dark:hover:text-green-300">Save</button>
                          <button onClick={() => setEditingWord(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-500 dark:hover:text-warm-300">Cancel</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setEditingWord(w.id); setEditWordSeverity(w.severity) }}
                          className={`text-xs px-1.5 py-0.5 rounded-full cursor-pointer hover:opacity-80 ${severityColors[w.severity]}`}
                          title="Click to edit severity"
                        >
                          {w.severity}
                        </button>
                      )}
                    </div>
                    {canEdit && (
                      <button
                        onClick={() => {
                          setConfirmDialog({
                            open: true,
                            title: 'Delete Word',
                            message: `Remove "${w.word}" from the compliance word list?`,
                            variant: 'danger',
                            onConfirm: () => { deleteWord(w.id); setConfirmDialog((p) => ({ ...p, open: false })) },
                          })
                        }}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  )
                })}
                {words.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-warm-500 py-4 text-center">No words in compliance list</p>
                )}
              </div>
            </div>
          )}

          {/* Prompt Tab */}
          {rulesTab === 'prompt' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500 dark:text-warm-400">
                The FCC compliance prompt is <strong>centralized</strong> — one shared rule set for every station ({'{{STATION_NAME}}'} is filled in per station).{!isSuperAdmin && ' Managed by a super-admin; read-only here.'}
              </p>
              <div className={`relative ${promptDirty ? 'ring-2 ring-amber-300 rounded-lg' : ''}`}>
                <textarea
                  value={compliancePrompt}
                  onChange={(e) => { setCompliancePrompt(e.target.value); setPromptDirty(true) }}
                  readOnly={!isSuperAdmin}
                  className="w-full border rounded-lg p-3 text-sm font-mono h-48 resize-y dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100 read-only:opacity-70 read-only:cursor-not-allowed"
                  placeholder="Compliance check prompt for AI..."
                />
              </div>
              {promptDirty && !compliancePrompt.trim() && (
                <p className="text-xs text-red-500">Prompt cannot be empty</p>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    setConfirmDialog({
                      open: true,
                      title: 'Reset Prompt',
                      message: 'Reset the compliance prompt to the default? Your changes will be lost.',
                      variant: 'danger',
                      onConfirm: () => {
                        setCompliancePrompt((settings.compliance_prompt_default as string) ?? '')
                        setPromptDirty(true)
                        setConfirmDialog((p) => ({ ...p, open: false }))
                      },
                    })
                  }}
                  className="text-xs text-gray-500 hover:text-gray-700 underline dark:text-warm-400 dark:hover:text-warm-200"
                >
                  Reset to default
                </button>
                <button
                  onClick={savePrompt}
                  disabled={!isSuperAdmin || !promptDirty || savingPrompt || !compliancePrompt.trim()}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
                >
                  {savingPrompt ? 'Saving...' : 'Save Prompt'}
                </button>
              </div>
            </div>
          )}

          {/* Checks Tab */}
          {rulesTab === 'checks' && (
            <div className="space-y-1">
              <p className="text-xs text-gray-500 dark:text-warm-400 mb-3">
                {isSuperAdmin
                  ? 'You are editing the central default that applies to every station (stations may still override locally).'
                  : 'Defaults are managed centrally; toggles here set an override for this station only.'}
              </p>
              <p className="text-xs font-semibold text-gray-400 dark:text-warm-500 uppercase tracking-wide mb-3">Check Types</p>
              {FLAG_TYPES.map((type) => (
                <div key={type} className="flex items-center justify-between py-3 border-b last:border-b-0 dark:border-warm-700">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-warm-100">{typeLabels[type]}</p>
                  </div>
                  <button
                    onClick={() => toggleCheckType(type, !checkToggles[type])}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checkToggles[type] ? 'bg-blue-600' : 'bg-gray-300 dark:bg-warm-600'}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checkToggles[type] ? 'translate-x-6' : 'translate-x-1'}`} />
                  </button>
                </div>
              ))}
              <div className="flex items-center justify-between py-3 mt-2 border-t dark:border-warm-700">
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-warm-100">Blocking Mode <span className="ml-1 text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">global</span></p>
                  <p className="text-xs text-gray-500 dark:text-warm-400">Hold episodes with an unresolved critical flag out of the QIR until it&apos;s cleared.{!isSuperAdmin && ' Managed by a super-admin.'}</p>
                </div>
                <button
                  onClick={() => toggleBlocking(!blocking)}
                  disabled={!isSuperAdmin}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${blocking ? 'bg-red-600' : 'bg-gray-300 dark:bg-warm-600'}`}
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${blocking ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmVariant={confirmDialog.variant}
        confirmLabel="Confirm"
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((p) => ({ ...p, open: false }))}
      />
    </div>
  )
}
