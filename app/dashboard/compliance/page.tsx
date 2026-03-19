'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { SkeletonCards, SkeletonTableRows } from '@/app/components/skeleton'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { useToast } from '@/app/components/toast'

interface ComplianceFlag {
  id: number
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
  resolved: boolean
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
}

const FLAG_TYPES = ['profanity', 'station_id_missing', 'technical', 'payola_plugola', 'sponsor_id', 'indecency'] as const
const SEVERITIES = ['info', 'warning', 'critical']

function getQuarterOptions(): { label: string; value: string }[] {
  const now = new Date()
  const options: { label: string; value: string }[] = []
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i * 3, 1)
    const q = Math.floor(d.getMonth() / 3) + 1
    const y = d.getFullYear()
    options.push({ label: `Q${q} ${y}`, value: `${y}-${q}` })
  }
  return options
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

export default function CompliancePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()

  // Filters from URL
  const [filterType, setFilterType] = useState(searchParams.get('type') ?? '')
  const [filterSeverity, setFilterSeverity] = useState(searchParams.get('severity') ?? '')
  const [filterResolution, setFilterResolution] = useState(searchParams.get('resolution') ?? 'unresolved')
  const [filterQuarter, setFilterQuarter] = useState(searchParams.get('quarter') ?? '')
  const [filterShow, setFilterShow] = useState(searchParams.get('show') ?? '')
  const [page, setPage] = useState(parseInt(searchParams.get('page') ?? '1'))

  // Data
  const [flags, setFlags] = useState<ComplianceFlag[]>([])
  const [stats, setStats] = useState<Stats>({ byType: {}, bySeverity: {}, total: 0 })
  const [showHealth, setShowHealth] = useState<ShowHealth[]>([])
  const [showHealthExpanded, setShowHealthExpanded] = useState(false)
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 })
  const [words, setWords] = useState<ComplianceWord[]>([])
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [loading, setLoading] = useState(true)

  // Selection for bulk resolve
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Resolve UI
  const [resolveTarget, setResolveTarget] = useState<number | null>(null)
  const [resolveNotes, setResolveNotes] = useState('')
  const [bulkResolveOpen, setBulkResolveOpen] = useState(false)
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
    if (filterResolution === 'unresolved') params.set('unresolved', 'true')
    else if (filterResolution === 'resolved') params.set('resolved', 'true')
    if (filterQuarter) {
      const [y, q] = filterQuarter.split('-')
      params.set('year', y)
      params.set('quarter', q)
    }
    if (filterShow) params.set('show', filterShow)
    if (page > 1) params.set('page', String(page))
    params.set('sort', 'created_at')
    params.set('dir', 'desc')
    return params
  }, [filterType, filterSeverity, filterResolution, filterQuarter, filterShow, page])

  // Fetch flags list
  const fetchFlags = useCallback(async () => {
    try {
      const params = buildApiParams()
      const res = await fetch(`/api/compliance?${params}`)
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
      const res = await fetch('/api/compliance?stats=true')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setStats(data.stats ?? { byType: {}, bySeverity: {}, total: 0 })
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
      fetch('/api/compliance/wordlist').then((r) => r.ok ? r.json() : { words: [] }),
      fetch('/api/settings').then((r) => r.ok ? r.json() : { settings: {} }),
      fetch('/api/compliance?by_show=true').then((r) => r.ok ? r.json() : { shows: [] }),
    ]).then(([, , wordData, settingsData, showData]) => {
      setShowHealth(showData.shows ?? [])
      setWords(wordData.words ?? [])
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
    if (filterResolution) params.set('resolution', filterResolution)
    if (filterQuarter) params.set('quarter', filterQuarter)
    if (filterShow) params.set('show', filterShow)
    if (page > 1) params.set('page', String(page))
    const qs = params.toString()
    router.replace(`/dashboard/compliance${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [filterType, filterSeverity, filterResolution, filterQuarter, filterShow, page, router])

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

  // Resolve single flag
  async function resolveFlag(id: number) {
    if (actionLoading) return
    setActionLoading(true)
    try {
      const res = await fetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, resolved: true, resolved_notes: resolveNotes, resolved_by: 'dashboard' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast('success', 'Flag resolved')
      setResolveTarget(null)
      setResolveNotes('')
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to resolve flag:', err)
      toast('error', 'Failed to resolve flag')
    } finally {
      setActionLoading(false)
    }
  }

  // Bulk resolve
  async function bulkResolve() {
    if (actionLoading) return
    setActionLoading(true)
    try {
      const ids = Array.from(selected)
      const res = await fetch('/api/compliance', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, resolved: true, resolved_notes: bulkNotes, resolved_by: 'dashboard' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast('success', `Resolved ${ids.length} flag${ids.length > 1 ? 's' : ''}`)
      setSelected(new Set())
      setBulkResolveOpen(false)
      setBulkNotes('')
      await Promise.all([fetchFlags(), fetchStats()])
    } catch (err) {
      console.error('Failed to bulk resolve:', err)
      toast('error', 'Failed to resolve flags')
    } finally {
      setActionLoading(false)
    }
  }

  // Add word
  async function addWord() {
    if (!newWord.trim() || addingWord) return
    setAddingWord(true)
    try {
      const res = await fetch('/api/compliance/wordlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: newWord.trim(), severity: newWordSeverity }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNewWord('')
      const listRes = await fetch('/api/compliance/wordlist')
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
      const res = await fetch(`/api/compliance/wordlist?id=${id}`, { method: 'DELETE' })
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
      const res = await fetch('/api/compliance/wordlist', {
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
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_prompt', value: compliancePrompt }),
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
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_checks_enabled', value: updated }),
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
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_blocking', value: String(b) }),
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
      const res = await fetch('/api/jobs', {
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
    if (filterType) params.set('type', filterType)
    if (filterSeverity) params.set('severity', filterSeverity)
    if (filterResolution === 'unresolved') params.set('unresolved', 'true')
    else if (filterResolution === 'resolved') params.set('unresolved', 'false')
    else params.set('unresolved', 'false') // "all" shows everything
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
        <a
          href={`/compliance-report?${buildReportUrl()}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-700 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
        >
          View Report
        </a>
      </div>

      {/* Summary Stats Strip — uses dedicated stats query for accurate totals */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {FLAG_TYPES.map((type) => (
          <div key={type} className="bg-white rounded-xl shadow-sm border p-3 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide dark:text-warm-500">{typeLabels[type]}</p>
            <p className="text-2xl font-bold text-gray-900 mt-1 dark:text-warm-100">{stats.byType[type] ?? 0}</p>
            <p className="text-xs text-gray-500 dark:text-warm-400">unresolved</p>
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
            <label className="block text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Resolution</label>
            <select
              value={filterResolution}
              onChange={(e) => { setFilterResolution(e.target.value); setPage(1) }}
              className="border rounded-lg px-3 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            >
              <option value="">All</option>
              <option value="unresolved">Unresolved</option>
              <option value="resolved">Resolved</option>
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
          {(filterType || filterSeverity || filterResolution || filterQuarter || filterShow) && (
            <button
              onClick={() => { setFilterType(''); setFilterSeverity(''); setFilterResolution(''); setFilterQuarter(''); setFilterShow(''); setPage(1) }}
              className="text-xs text-gray-500 hover:text-gray-700 underline dark:text-warm-400 dark:hover:text-warm-200"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Bulk Actions */}
      {selected.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 flex items-center justify-between dark:bg-blue-900/20 dark:border-blue-800/40">
          <span className="text-sm text-blue-800 font-medium dark:text-blue-300">{selected.size} flag{selected.size > 1 ? 's' : ''} selected</span>
          <div className="flex gap-2">
            <button
              onClick={() => setBulkResolveOpen(true)}
              disabled={actionLoading}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
            >
              Resolve Selected
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

      {/* Bulk resolve notes dialog */}
      {bulkResolveOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setBulkResolveOpen(false)} />
          <div className="relative bg-white rounded-xl shadow-xl max-w-md w-full mx-4 p-6 dark:bg-surface-raised dark:shadow-card-dark">
            <h3 className="text-lg font-semibold text-gray-900 mb-2 dark:text-warm-100">Bulk Resolve {selected.size} Flags</h3>
            <textarea
              value={bulkNotes}
              onChange={(e) => setBulkNotes(e.target.value)}
              placeholder="Resolution notes (optional)..."
              className="w-full border rounded-lg p-3 text-sm mb-4 h-24 resize-none dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            />
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setBulkResolveOpen(false)}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 dark:bg-warm-700 dark:text-warm-200 dark:hover:bg-warm-600"
              >
                Cancel
              </button>
              <button
                onClick={bulkResolve}
                disabled={actionLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600"
              >
                {actionLoading ? 'Resolving...' : 'Resolve All'}
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
                  const episodeUrl = `/dashboard/episodes/${flag.episode_id}${flag.timestamp_seconds != null ? `?seek=${flag.timestamp_seconds}` : ''}`
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
                          href={`/dashboard/episodes/${flag.episode_id}?seek=${flag.timestamp_seconds}`}
                          className="text-blue-600 hover:underline font-mono text-xs"
                        >
                          {formatTimestamp(flag.timestamp_seconds)}
                        </a>
                      ) : (
                        <span className="text-gray-400 dark:text-warm-500">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {flag.resolved ? (
                        <span className="text-xs text-green-600 dark:text-green-400 font-medium">Resolved</span>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Open</span>
                      )}
                    </td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      {!flag.resolved && (
                        <>
                          {resolveTarget === flag.id ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="text"
                                value={resolveNotes}
                                onChange={(e) => setResolveNotes(e.target.value)}
                                placeholder="Notes..."
                                className="border rounded px-2 py-1 text-xs w-32 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') resolveFlag(flag.id)
                                  if (e.key === 'Escape') { setResolveTarget(null); setResolveNotes('') }
                                }}
                              />
                              <button
                                onClick={() => resolveFlag(flag.id)}
                                disabled={actionLoading}
                                className="text-xs text-green-600 hover:text-green-800 font-medium disabled:opacity-50"
                              >
                                {actionLoading ? '...' : 'Save'}
                              </button>
                              <button
                                onClick={() => { setResolveTarget(null); setResolveNotes('') }}
                                className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-500 dark:hover:text-warm-300"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setResolveTarget(flag.id)}
                              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                            >
                              Resolve
                            </button>
                          )}
                        </>
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
              <div className="divide-y dark:divide-warm-700 max-h-80 overflow-y-auto">
                {words.map((w) => (
                  <div key={w.id} className="flex items-center justify-between py-2 px-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono dark:text-warm-100">{w.word}</span>
                      {editingWord === w.id ? (
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
                  </div>
                ))}
                {words.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-warm-500 py-4 text-center">No words in compliance list</p>
                )}
              </div>
            </div>
          )}

          {/* Prompt Tab */}
          {rulesTab === 'prompt' && (
            <div className="space-y-4">
              <div className={`relative ${promptDirty ? 'ring-2 ring-amber-300 rounded-lg' : ''}`}>
                <textarea
                  value={compliancePrompt}
                  onChange={(e) => { setCompliancePrompt(e.target.value); setPromptDirty(true) }}
                  className="w-full border rounded-lg p-3 text-sm font-mono h-48 resize-y dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
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
                  disabled={!promptDirty || savingPrompt || !compliancePrompt.trim()}
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
                  <p className="text-sm font-medium text-gray-900 dark:text-warm-100">Blocking Mode</p>
                  <p className="text-xs text-gray-500 dark:text-warm-400">Block non-compliant episodes from QIR inclusion</p>
                </div>
                <button
                  onClick={() => toggleBlocking(!blocking)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${blocking ? 'bg-red-600' : 'bg-gray-300 dark:bg-warm-600'}`}
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
