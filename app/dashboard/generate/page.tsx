'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
import dynamic from 'next/dynamic'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

/* ─── lazy-loaded report components ─── */
const FullReportView = dynamic(() => import('@/app/components/qir-report-view').then(m => ({ default: m.FullReportView })), {
  loading: () => <div className="bg-white rounded-lg shadow dark:bg-surface-raised dark:shadow-card-dark p-6"><div className="h-48 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" /></div>,
  ssr: false,
})
const CuratedEntriesView = dynamic(() => import('@/app/components/qir-report-view').then(m => ({ default: m.CuratedEntriesView })), {
  loading: () => <div className="h-48 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" />,
  ssr: false,
})

interface QirEntry {
  episode_id: number
  show_name: string
  host: string
  air_date: string
  start_time: string
  duration: number
  headline: string
  guest: string
  summary: string
  issue_category: string
}

interface QirDraft {
  id: number
  year: number
  quarter: number
  status: 'draft' | 'final'
  curated_entries: QirEntry[]
  settings_snapshot: {
    max_entries_per_category?: number
    issue_categories?: string[]
    included_shows?: string[] | null
    guidance?: string | null
  } | null
  full_text: string | null
  curated_text: string | null
  version: number
  created_at: string
  updated_at: string
}

interface AvailableShow {
  show_key: string
  show_name: string
  episode_count: number
}

interface ValidationCheck {
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

interface ServiceRating {
  label: string
  score: number
  maxScore: number
  detail: string
  suggestion: string
}

const DEFAULT_CATEGORIES = [
  'Civil Rights / Social Justice', 'Immigration', 'Economy / Labor',
  'Environment / Climate', 'Government / Politics', 'Health',
  'International Affairs / War & Peace', 'Arts & Culture',
]

function getQuarterOptions() {
  const options: { label: string; year: number; quarter: number }[] = []
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentQ = Math.floor(now.getMonth() / 3) + 1

  for (let y = currentYear; y >= currentYear - 1; y--) {
    const maxQ = y === currentYear ? currentQ : 4
    for (let q = maxQ; q >= 1; q--) {
      options.push({ label: `Q${q} ${y}`, year: y, quarter: q })
    }
  }
  return options
}

function groupByCategory(entries: QirEntry[]): Record<string, QirEntry[]> {
  const grouped: Record<string, QirEntry[]> = {}
  for (const e of entries) {
    const cat = e.issue_category || 'Uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(e)
  }
  return grouped
}

function runValidation(draft: QirDraft, complianceSummary: Record<string, { count: number; critical: number }>, allCategories: string[]): ValidationCheck[] {
  const checks: ValidationCheck[] = []
  const entries = draft.curated_entries ?? []
  const grouped = groupByCategory(entries)
  const coveredCategories = Object.keys(grouped).filter(c => c !== 'Uncategorized')

  // 1. Minimum entries
  if (entries.length >= 20) {
    checks.push({ label: 'Entry count', status: 'pass', detail: `${entries.length} entries (20+ recommended)` })
  } else if (entries.length >= 10) {
    checks.push({ label: 'Entry count', status: 'warn', detail: `${entries.length} entries (20+ recommended)` })
  } else {
    checks.push({ label: 'Entry count', status: 'fail', detail: `Only ${entries.length} entries (20+ recommended)` })
  }

  // 2. Category coverage
  const missingCats = allCategories.filter(c => !coveredCategories.includes(c))
  if (missingCats.length === 0) {
    checks.push({ label: 'Category coverage', status: 'pass', detail: `All ${allCategories.length} categories covered` })
  } else if (missingCats.length <= 3) {
    checks.push({ label: 'Category coverage', status: 'warn', detail: `Missing: ${missingCats.join(', ')}` })
  } else {
    checks.push({ label: 'Category coverage', status: 'fail', detail: `Missing ${missingCats.length} categories: ${missingCats.join(', ')}` })
  }

  // 3. Show variety
  const uniqueShows = new Set(entries.map(e => e.show_name))
  if (uniqueShows.size >= 8) {
    checks.push({ label: 'Show variety', status: 'pass', detail: `${uniqueShows.size} different shows` })
  } else if (uniqueShows.size >= 4) {
    checks.push({ label: 'Show variety', status: 'warn', detail: `Only ${uniqueShows.size} different shows (8+ recommended)` })
  } else {
    checks.push({ label: 'Show variety', status: 'fail', detail: `Only ${uniqueShows.size} different shows (8+ recommended)` })
  }

  // 4. Date spread
  const dates = entries.map(e => e.air_date).filter(Boolean).sort()
  if (dates.length >= 2) {
    const first = new Date(dates[0])
    const last = new Date(dates[dates.length - 1])
    const spanDays = Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24))
    if (spanDays >= 60) {
      checks.push({ label: 'Date distribution', status: 'pass', detail: `Spans ${spanDays} days across the quarter` })
    } else if (spanDays >= 30) {
      checks.push({ label: 'Date distribution', status: 'warn', detail: `Only spans ${spanDays} days (aim for full quarter)` })
    } else {
      checks.push({ label: 'Date distribution', status: 'fail', detail: `Only spans ${spanDays} days - entries are clustered` })
    }
  }

  // 5. Missing fields
  const missingFields = entries.filter(e => !e.summary || !e.host || !e.headline)
  if (missingFields.length === 0) {
    checks.push({ label: 'Complete entries', status: 'pass', detail: 'All entries have summary, host, and headline' })
  } else {
    checks.push({ label: 'Complete entries', status: 'warn', detail: `${missingFields.length} entries missing summary, host, or headline` })
  }

  // 6. Compliance flags
  const totalFlags = Object.values(complianceSummary).reduce((a, b) => a + b.count, 0)
  const criticalFlags = Object.values(complianceSummary).reduce((a, b) => a + b.critical, 0)
  if (totalFlags === 0) {
    checks.push({ label: 'Compliance', status: 'pass', detail: 'No unresolved compliance flags' })
  } else if (criticalFlags > 0) {
    checks.push({ label: 'Compliance', status: 'fail', detail: `${criticalFlags} critical compliance flags unresolved` })
  } else {
    checks.push({ label: 'Compliance', status: 'warn', detail: `${totalFlags} compliance warnings unresolved` })
  }

  return checks
}

function computeServiceRating(entries: QirEntry[], allCategories: string[]): { ratings: ServiceRating[]; overall: number } {
  const ratings: ServiceRating[] = []

  // 1. Category breadth (0-25): how many FCC issue categories are represented
  const grouped = groupByCategory(entries)
  const coveredCategories = Object.keys(grouped).filter(c => c !== 'Uncategorized')
  const catRatio = allCategories.length > 0 ? coveredCategories.length / allCategories.length : 0
  const catScore = Math.round(catRatio * 25)
  const missingCats = allCategories.filter(c => !coveredCategories.includes(c))
  ratings.push({
    label: 'Issue Breadth',
    score: catScore,
    maxScore: 25,
    detail: `${coveredCategories.length} of ${allCategories.length} FCC issue categories covered`,
    suggestion: missingCats.length > 0
      ? `Add coverage for: ${missingCats.slice(0, 3).join(', ')}${missingCats.length > 3 ? ` (+${missingCats.length - 3} more)` : ''}`
      : 'All issue categories represented',
  })

  // 2. Show diversity (0-25): how many unique shows contribute
  const uniqueShows = new Set(entries.map(e => e.show_name))
  const showCounts = new Map<string, number>()
  for (const e of entries) {
    showCounts.set(e.show_name, (showCounts.get(e.show_name) ?? 0) + 1)
  }
  const showScore = Math.min(25, Math.round((uniqueShows.size / 12) * 25))
  const dominantShow = Array.from(showCounts.entries()).sort((a, b) => b[1] - a[1])[0]
  ratings.push({
    label: 'Show Diversity',
    score: showScore,
    maxScore: 25,
    detail: `${uniqueShows.size} unique shows represented`,
    suggestion: uniqueShows.size < 8
      ? 'Include more shows to demonstrate broad community programming'
      : dominantShow && dominantShow[1] > entries.length * 0.3
        ? `"${dominantShow[0]}" has ${dominantShow[1]} entries (${Math.round(dominantShow[1] / entries.length * 100)}%) - consider reducing`
        : 'Good balance across shows',
  })

  // 3. Guest & substantive content (0-25): entries with identified guests show real engagement
  const withGuests = entries.filter(e => e.guest && e.guest.toLowerCase() !== 'none' && e.guest.trim() !== '')
  const withSubstance = entries.filter(e => e.summary && e.summary.length > 100 && e.headline)
  const guestRatio = entries.length > 0 ? withGuests.length / entries.length : 0
  const substanceRatio = entries.length > 0 ? withSubstance.length / entries.length : 0
  const contentScore = Math.round(((guestRatio * 0.5) + (substanceRatio * 0.5)) * 25)
  ratings.push({
    label: 'Community Engagement',
    score: contentScore,
    maxScore: 25,
    detail: `${withGuests.length} entries feature identified guests, ${withSubstance.length} have detailed descriptions`,
    suggestion: guestRatio < 0.5
      ? 'Prioritize episodes that featured community guests and expert interviews'
      : 'Strong guest representation demonstrates active community engagement',
  })

  // 4. Temporal coverage (0-25): spread across the full quarter
  const dates = entries.map(e => e.air_date).filter(Boolean).sort()
  let timeScore = 0
  if (dates.length >= 2) {
    const first = new Date(dates[0])
    const last = new Date(dates[dates.length - 1])
    const spanDays = Math.round((last.getTime() - first.getTime()) / (1000 * 60 * 60 * 24))
    // Full quarter is ~90 days
    timeScore = Math.min(25, Math.round((spanDays / 80) * 25))
    // Check for monthly distribution (3 months in a quarter)
    const months = new Set(dates.map(d => d.slice(0, 7)))
    ratings.push({
      label: 'Temporal Coverage',
      score: timeScore,
      maxScore: 25,
      detail: `Coverage spans ${spanDays} days across ${months.size} month(s)`,
      suggestion: months.size < 3
        ? 'Ensure entries from all 3 months of the quarter for consistent coverage'
        : spanDays < 60
          ? 'Entries are clustered - spread selections across the full quarter'
          : 'Good distribution across the quarter',
    })
  } else {
    ratings.push({
      label: 'Temporal Coverage',
      score: 0,
      maxScore: 25,
      detail: 'Not enough dated entries to evaluate',
      suggestion: 'Need entries with air dates to assess temporal coverage',
    })
  }

  const overall = ratings.reduce((sum, r) => sum + r.score, 0)
  return { ratings, overall }
}

const CHECK_ICONS: Record<string, { icon: string; bg: string; text: string }> = {
  pass: { icon: '\u2713', bg: 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800/40', text: 'text-emerald-700 dark:text-emerald-300' },
  warn: { icon: '!', bg: 'bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/40', text: 'text-amber-700 dark:text-amber-300' },
  fail: { icon: '\u2717', bg: 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/40', text: 'text-red-700 dark:text-red-300' },
}

function getRatingColor(score: number): string {
  if (score >= 80) return 'text-emerald-600 dark:text-emerald-400'
  if (score >= 60) return 'text-blue-600 dark:text-blue-400'
  if (score >= 40) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function getRatingLabel(score: number): string {
  if (score >= 80) return 'Strong'
  if (score >= 60) return 'Good'
  if (score >= 40) return 'Fair'
  return 'Needs Work'
}

function getRatingBarColor(score: number, max: number): string {
  const pct = max > 0 ? score / max : 0
  if (pct >= 0.8) return 'bg-emerald-500 dark:bg-emerald-400'
  if (pct >= 0.6) return 'bg-blue-500 dark:bg-blue-400'
  if (pct >= 0.4) return 'bg-amber-500 dark:bg-amber-400'
  return 'bg-red-500 dark:bg-red-400'
}

export default function GenerateQirPage() {
  const quarterOptions = getQuarterOptions()
  const [selectedQuarter, setSelectedQuarter] = useState(quarterOptions[0])
  const [drafts, setDrafts] = useState<QirDraft[]>([])
  const [activeDraft, setActiveDraft] = useState<QirDraft | null>(null)
  const [generating, setGenerating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [view, setView] = useState<'curated' | 'full'>('curated')
  const [editingEntry, setEditingEntry] = useState<number | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [confirmFinalize, setConfirmFinalize] = useState<number | null>(null)
  const [complianceSummary, setComplianceSummary] = useState<Record<string, { count: number; critical: number }>>({})
  const [issueCategories, setIssueCategories] = useState<string[]>(DEFAULT_CATEGORIES)

  // Show selection state
  const [availableShows, setAvailableShows] = useState<AvailableShow[]>([])
  const [selectedShows, setSelectedShows] = useState<Set<string>>(new Set())
  const [showsLoading, setShowsLoading] = useState(false)
  const [showPanelOpen, setShowPanelOpen] = useState(false)

  // Guidance state for re-generation
  const [guidance, setGuidance] = useState('')
  const [showGuidance, setShowGuidance] = useState(false)

  const fetchShows = useCallback(async () => {
    setShowsLoading(true)
    try {
      const res = await fetch(
        `/api/qir/shows?year=${selectedQuarter.year}&quarter=${selectedQuarter.quarter}`
      )
      if (res.ok) {
        const data = await res.json()
        const shows: AvailableShow[] = data.shows ?? []
        setAvailableShows(shows)
        // Select all by default
        setSelectedShows(new Set(shows.map(s => s.show_key)))
      }
    } finally {
      setShowsLoading(false)
    }
  }, [selectedQuarter.year, selectedQuarter.quarter])

  const fetchDrafts = useCallback(async () => {
    setLoading(true)
    try {
      const [draftsRes, dashRes, settingsRes] = await Promise.all([
        fetch(`/api/qir?year=${selectedQuarter.year}&quarter=${selectedQuarter.quarter}`),
        fetch('/api/dashboard'),
        fetch('/api/settings'),
      ])
      if (draftsRes.ok) {
        const data = await draftsRes.json()
        setDrafts(data.drafts ?? [])
        if (data.drafts?.length && !activeDraft) {
          setActiveDraft(data.drafts[0])
        }
      }
      if (dashRes.ok) {
        const data = await dashRes.json()
        setComplianceSummary(data.complianceSummary ?? {})
      }
      if (settingsRes.ok) {
        const data = await settingsRes.json()
        if (Array.isArray(data.settings?.issue_categories)) {
          setIssueCategories(data.settings.issue_categories)
        }
      }
    } finally {
      setLoading(false)
    }
  }, [selectedQuarter.year, selectedQuarter.quarter])

  useEffect(() => {
    setActiveDraft(null)
    fetchDrafts()
    fetchShows()
  }, [fetchDrafts, fetchShows])

  const totalAvailableEpisodes = useMemo(
    () => availableShows.reduce((sum, s) => sum + s.episode_count, 0),
    [availableShows]
  )
  const selectedEpisodeCount = useMemo(
    () => availableShows
      .filter(s => selectedShows.has(s.show_key))
      .reduce((sum, s) => sum + s.episode_count, 0),
    [availableShows, selectedShows]
  )

  async function handleGenerate() {
    setGenerating(true)
    try {
      const allSelected = selectedShows.size === availableShows.length
      const res = await fetch('/api/qir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          year: selectedQuarter.year,
          quarter: selectedQuarter.quarter,
          includedShows: allSelected ? undefined : Array.from(selectedShows),
          guidance: guidance.trim() || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Generation failed')
        return
      }
      if (data.drafted === false) {
        alert(data.reason === 'no episodes match filter'
          ? 'No episodes match the selected shows. Try including more shows.'
          : 'No completed episodes found for this quarter.')
        return
      }
      await fetchDrafts()
    } finally {
      setGenerating(false)
    }
  }

  async function handleFinalize(draftId: number, action: 'finalize' | 'unfinalize') {
    if (action === 'finalize') {
      setConfirmFinalize(draftId)
      return
    }
    await executeFinalize(draftId, action)
  }

  async function executeFinalize(draftId: number, action: 'finalize' | 'unfinalize') {
    setConfirmFinalize(null)
    setActionLoading(action)
    try {
      const res = await fetch('/api/qir', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draftId, action }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        alert(data.error ?? `Failed to ${action}`)
        return
      }
      await fetchDrafts()
      if (activeDraft?.id === draftId) {
        setActiveDraft((prev) =>
          prev ? { ...prev, status: action === 'finalize' ? 'final' : 'draft' } : null
        )
      }
    } finally {
      setActionLoading(null)
    }
  }

  async function handleRemoveEntry(episodeId: number) {
    if (!activeDraft) return
    const updated = activeDraft.curated_entries.filter(
      (e) => e.episode_id !== episodeId
    )
    await saveEntries(updated)
  }

  async function handleSaveEditEntry(episodeId: number) {
    if (!activeDraft) return
    const updated = activeDraft.curated_entries.map((e) =>
      e.episode_id === episodeId ? { ...e, summary: editSummary } : e
    )
    await saveEntries(updated)
    setEditingEntry(null)
  }

  async function saveEntries(entries: QirEntry[]) {
    if (!activeDraft) return
    const res = await fetch('/api/qir', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: activeDraft.id,
        action: 'update-entries',
        curated_entries: entries,
      }),
    })
    if (res.ok) {
      setActiveDraft((prev) => (prev ? { ...prev, curated_entries: entries } : null))
    }
  }

  function handleSelectAll() {
    setSelectedShows(new Set(availableShows.map(s => s.show_key)))
  }

  function handleDeselectAll() {
    setSelectedShows(new Set())
  }

  function toggleShow(showKey: string) {
    setSelectedShows(prev => {
      const next = new Set(prev)
      if (next.has(showKey)) {
        next.delete(showKey)
      } else {
        next.add(showKey)
      }
      return next
    })
  }

  function handleRegenerate() {
    // Pre-populate guidance from the active draft's previous settings if available
    if (activeDraft?.settings_snapshot?.guidance) {
      setGuidance(activeDraft.settings_snapshot.guidance)
    }
    if (activeDraft?.settings_snapshot?.included_shows) {
      setSelectedShows(new Set(activeDraft.settings_snapshot.included_shows))
    }
    setShowGuidance(true)
    setShowPanelOpen(true)
  }

  const curatedGrouped = activeDraft
    ? groupByCategory(activeDraft.curated_entries)
    : {}
  const totalCurated = activeDraft?.curated_entries?.length ?? 0

  // Run validation checks if we have a draft
  const validationChecks = activeDraft ? runValidation(activeDraft, complianceSummary, issueCategories) : []
  const hasBlockers = validationChecks.some(c => c.status === 'fail')

  // Community service rating
  const serviceRating = useMemo(() => {
    if (!activeDraft?.curated_entries?.length) return null
    return computeServiceRating(activeDraft.curated_entries, issueCategories)
  }, [activeDraft, issueCategories])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">QIR Builder</h2>
        <div className="flex items-center gap-3">
          <select
            value={`${selectedQuarter.year}-${selectedQuarter.quarter}`}
            onChange={(e) => {
              const [y, q] = e.target.value.split('-').map(Number)
              const opt = quarterOptions.find(
                (o) => o.year === y && o.quarter === q
              )
              if (opt) setSelectedQuarter(opt)
            }}
            className="border rounded px-3 py-2 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
          >
            {quarterOptions.map((o) => (
              <option key={`${o.year}-${o.quarter}`} value={`${o.year}-${o.quarter}`}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setShowPanelOpen(!showPanelOpen)}
            className="px-3 py-2 border rounded text-sm hover:bg-gray-50 dark:border-warm-600 dark:text-warm-300 dark:hover:bg-warm-700"
          >
            {showPanelOpen ? 'Hide Options' : 'Customize'}
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating || selectedShows.size === 0}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100 disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>

      {/* ═══ Show Selection & Generation Options Panel ═══ */}
      {showPanelOpen && (
        <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark">
          <div className="px-5 py-3 border-b dark:border-warm-700 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-400 dark:text-warm-500 uppercase tracking-wide">
              Generation Options
            </h3>
            <span className="text-xs text-gray-500 dark:text-warm-400">
              {selectedShows.size} of {availableShows.length} shows selected ({selectedEpisodeCount} of {totalAvailableEpisodes} episodes)
            </span>
          </div>

          {/* Show checkboxes */}
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-700 dark:text-warm-200">Include Shows</p>
              <div className="flex gap-2">
                <button
                  onClick={handleSelectAll}
                  className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30 rounded"
                >
                  Select All
                </button>
                <button
                  onClick={handleDeselectAll}
                  className="text-xs px-2 py-1 text-gray-600 hover:bg-gray-100 dark:text-warm-400 dark:hover:bg-warm-700 rounded"
                >
                  Deselect All
                </button>
              </div>
            </div>

            {showsLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="h-8 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" />
                ))}
              </div>
            ) : availableShows.length === 0 ? (
              <p className="text-sm text-gray-500 dark:text-warm-400">
                No summarized episodes found for {selectedQuarter.label}.
              </p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 max-h-[240px] overflow-y-auto">
                {availableShows.map((show) => (
                  <label
                    key={show.show_key}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer text-sm transition-colors ${
                      selectedShows.has(show.show_key)
                        ? 'bg-blue-50 dark:bg-blue-900/20'
                        : 'hover:bg-gray-50 dark:hover:bg-warm-700/50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedShows.has(show.show_key)}
                      onChange={() => toggleShow(show.show_key)}
                      className="rounded border-gray-300 text-blue-600 dark:border-warm-600 dark:bg-warm-800"
                    />
                    <span className="truncate text-gray-800 dark:text-warm-200">
                      {show.show_name}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0">
                      ({show.episode_count})
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Guidance / custom instructions */}
          <div className="px-5 pb-4 border-t dark:border-warm-700 pt-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-medium text-gray-700 dark:text-warm-200">
                Curation Guidance
                <span className="text-xs font-normal text-gray-400 dark:text-warm-500 ml-1.5">(optional)</span>
              </p>
              {!showGuidance && (
                <button
                  onClick={() => setShowGuidance(true)}
                  className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30 rounded"
                >
                  Add Guidance
                </button>
              )}
            </div>
            {showGuidance && (
              <div>
                <textarea
                  value={guidance}
                  onChange={(e) => setGuidance(e.target.value)}
                  placeholder="e.g., Prioritize health and immigration topics this quarter. Include more community interview segments. Focus on local Los Angeles issues over national coverage."
                  className="w-full border dark:border-warm-600 rounded p-2.5 text-sm dark:bg-warm-800 dark:text-warm-100 placeholder:text-gray-400 dark:placeholder:text-warm-500"
                  rows={3}
                />
                <p className="text-xs text-gray-400 dark:text-warm-500 mt-1">
                  This guidance is sent to the AI curation model to influence which episodes are selected.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ Community Service Rating ═══ */}
      {activeDraft && serviceRating && (
        <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark">
          <div className="px-5 py-3 border-b dark:border-warm-700 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-400 dark:text-warm-500 uppercase tracking-wide">
              Community Service Rating
            </h3>
            <div className="flex items-center gap-2">
              <span className={`text-lg font-bold ${getRatingColor(serviceRating.overall)}`}>
                {serviceRating.overall}/100
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                serviceRating.overall >= 80 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' :
                serviceRating.overall >= 60 ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' :
                serviceRating.overall >= 40 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
                'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
              }`}>
                {getRatingLabel(serviceRating.overall)}
              </span>
            </div>
          </div>
          <div className="divide-y dark:divide-warm-700">
            {serviceRating.ratings.map((r) => (
              <div key={r.label} className="px-5 py-3">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-sm font-medium text-gray-900 dark:text-warm-100">{r.label}</p>
                  <span className={`text-sm font-semibold ${getRatingColor(r.score * (100 / r.maxScore))}`}>
                    {r.score}/{r.maxScore}
                  </span>
                </div>
                <div className="w-full bg-gray-100 dark:bg-warm-700 rounded-full h-1.5 mb-1.5">
                  <div
                    className={`h-1.5 rounded-full transition-all ${getRatingBarColor(r.score, r.maxScore)}`}
                    style={{ width: `${(r.score / r.maxScore) * 100}%` }}
                  />
                </div>
                <p className="text-xs text-gray-500 dark:text-warm-400">{r.detail}</p>
                <p className="text-xs text-gray-600 dark:text-warm-300 mt-0.5 italic">{r.suggestion}</p>
              </div>
            ))}
          </div>
          {serviceRating.overall < 80 && activeDraft.status === 'draft' && (
            <div className="px-5 py-3 border-t dark:border-warm-700 bg-gray-50 dark:bg-warm-800/50 rounded-b-xl">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-600 dark:text-warm-300">
                  Adjust show selection or add guidance, then regenerate to improve the score.
                </p>
                <button
                  onClick={handleRegenerate}
                  disabled={generating}
                  className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50"
                >
                  Tweak & Regenerate
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ Pre-finalization Validation Checklist ═══ */}
      {activeDraft && activeDraft.status === 'draft' && validationChecks.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark">
          <div className="px-5 py-3 border-b dark:border-warm-700 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-400 dark:text-warm-500 uppercase tracking-wide">Pre-Finalization Checklist</h3>
            {hasBlockers ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 font-medium">Issues found</span>
            ) : (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-medium">Ready</span>
            )}
          </div>
          <div className="divide-y dark:divide-warm-700">
            {validationChecks.map((check) => {
              const style = CHECK_ICONS[check.status]
              return (
                <div key={check.label} className="flex items-center gap-3 px-5 py-2.5">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border ${style.bg} ${style.text}`}>
                    {style.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-warm-100">{check.label}</p>
                    <p className="text-xs text-gray-500 dark:text-warm-400">{check.detail}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Draft History */}
      {drafts.length > 0 && (
        <div className="bg-white rounded-lg shadow dark:bg-surface-raised dark:shadow-card-dark">
          <div className="px-4 py-3 border-b dark:border-warm-700">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-warm-400 uppercase">
              Draft History
            </h3>
          </div>
          <div className="divide-y dark:divide-warm-700">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-warm-700/50 ${
                  activeDraft?.id === draft.id ? 'bg-blue-50 dark:bg-blue-900/30' : ''
                }`}
                onClick={() => setActiveDraft(draft)}
              >
                <div>
                  <span className="text-sm font-medium">
                    Version {draft.version}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-warm-400 ml-2">
                    {new Date(draft.created_at).toLocaleDateString()}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-warm-400 ml-2">
                    {(draft.curated_entries as QirEntry[])?.length ?? 0} entries
                  </span>
                  {draft.settings_snapshot?.guidance && (
                    <span className="text-xs text-blue-500 dark:text-blue-400 ml-2" title={draft.settings_snapshot.guidance}>
                      (guided)
                    </span>
                  )}
                  {draft.settings_snapshot?.included_shows && (
                    <span className="text-xs text-purple-500 dark:text-purple-400 ml-1" title={`${draft.settings_snapshot.included_shows.length} shows selected`}>
                      (filtered)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      draft.status === 'final'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                        : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300'
                    }`}
                  >
                    {draft.status}
                  </span>
                  {draft.status === 'draft' ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleFinalize(draft.id, 'finalize')
                      }}
                      disabled={actionLoading !== null}
                      className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600 disabled:opacity-50"
                    >
                      Finalize
                    </button>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleFinalize(draft.id, 'unfinalize')
                      }}
                      disabled={actionLoading !== null}
                      className="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 dark:bg-warm-600 dark:hover:bg-warm-500 disabled:opacity-50"
                    >
                      Un-finalize
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <p className="text-gray-500 dark:text-warm-400">Loading drafts...</p>}

      {/* Active Draft View */}
      {activeDraft && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold">
                Q{activeDraft.quarter} {activeDraft.year} &mdash; v{activeDraft.version}
              </h3>
              <span className="text-sm text-gray-500 dark:text-warm-400">
                {totalCurated} curated entries
              </span>
            </div>
            <div className="flex items-center gap-2">
              {activeDraft.status === 'draft' && (
                <button
                  onClick={handleRegenerate}
                  disabled={generating}
                  className="text-xs px-3 py-1.5 border border-blue-300 text-blue-600 rounded hover:bg-blue-50 dark:border-blue-700 dark:text-blue-400 dark:hover:bg-blue-900/30 disabled:opacity-50"
                >
                  Tweak & Regenerate
                </button>
              )}
              <div className="flex rounded border dark:border-warm-600 overflow-hidden text-sm">
                <button
                  onClick={() => setView('curated')}
                  className={`px-3 py-1.5 ${
                    view === 'curated'
                      ? 'bg-gray-900 text-white dark:bg-warm-200 dark:text-warm-900'
                      : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-surface-raised dark:text-warm-300 dark:hover:bg-warm-700'
                  }`}
                >
                  Curated
                </button>
                <button
                  onClick={() => setView('full')}
                  className={`px-3 py-1.5 ${
                    view === 'full'
                      ? 'bg-gray-900 text-white dark:bg-warm-200 dark:text-warm-900'
                      : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-surface-raised dark:text-warm-300 dark:hover:bg-warm-700'
                  }`}
                >
                  Full Report
                </button>
              </div>
              <a
                href={`/api/qir/export?id=${activeDraft.id}&format=csv`}
                className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50 dark:border-warm-600 dark:text-warm-300 dark:hover:bg-warm-700"
              >
                Export CSV
              </a>
              <a
                href={`/api/qir/export?id=${activeDraft.id}&format=text`}
                className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50 dark:border-warm-600 dark:text-warm-300 dark:hover:bg-warm-700"
              >
                Export Text
              </a>
            </div>
          </div>

          {view === 'full' ? (
            <FullReportView text={activeDraft.full_text} />
          ) : (
            <CuratedEntriesView
              groupedEntries={curatedGrouped}
              isDraft={activeDraft.status === 'draft'}
              editingEntry={editingEntry}
              editSummary={editSummary}
              onSetEditingEntry={setEditingEntry}
              onSetEditSummary={setEditSummary}
              onSaveEdit={handleSaveEditEntry}
              onRemoveEntry={handleRemoveEntry}
            />
          )}
        </div>
      )}

      {!loading && drafts.length === 0 && (
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500 dark:bg-surface-raised dark:shadow-card-dark dark:text-warm-400">
          <p className="text-lg mb-2">No drafts yet for {selectedQuarter.label}</p>
          <p className="text-sm">
            Click &quot;Customize&quot; to select shows, then &quot;Generate Report&quot; to create a QIR draft.
          </p>
        </div>
      )}

      {/* Finalize Confirmation */}
      <ConfirmDialog
        open={confirmFinalize !== null}
        title="Finalize QIR Draft"
        message={
          hasBlockers
            ? 'This draft has validation issues. Finalize anyway? It will be published on the public page.'
            : 'Finalize this QIR draft? It will be published on the public page.'
        }
        confirmLabel="Finalize"
        confirmVariant={hasBlockers ? 'danger' : 'primary'}
        onConfirm={() => confirmFinalize && executeFinalize(confirmFinalize, 'finalize')}
        onCancel={() => setConfirmFinalize(null)}
      />
    </div>
  )
}
