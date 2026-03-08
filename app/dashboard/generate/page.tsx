'use client'

import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

/* ─── lazy-loaded report components ─── */
const FullReportView = dynamic(() => import('@/app/components/qir-report-view').then(m => ({ default: m.FullReportView })), {
  loading: () => <div className="bg-white rounded-lg shadow p-6"><div className="h-48 bg-gray-100 rounded animate-pulse" /></div>,
  ssr: false,
})
const CuratedEntriesView = dynamic(() => import('@/app/components/qir-report-view').then(m => ({ default: m.CuratedEntriesView })), {
  loading: () => <div className="h-48 bg-gray-100 rounded animate-pulse" />,
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
  full_text: string | null
  curated_text: string | null
  version: number
  created_at: string
  updated_at: string
}

interface ValidationCheck {
  label: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

const ALL_CATEGORIES = [
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

function runValidation(draft: QirDraft, complianceSummary: Record<string, { count: number; critical: number }>): ValidationCheck[] {
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
  const missingCats = ALL_CATEGORIES.filter(c => !coveredCategories.includes(c))
  if (missingCats.length === 0) {
    checks.push({ label: 'Category coverage', status: 'pass', detail: `All ${ALL_CATEGORIES.length} categories covered` })
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

const CHECK_ICONS: Record<string, { icon: string; bg: string; text: string }> = {
  pass: { icon: '\u2713', bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  warn: { icon: '!', bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  fail: { icon: '\u2717', bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
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

  const fetchDrafts = useCallback(async () => {
    setLoading(true)
    try {
      const [draftsRes, dashRes] = await Promise.all([
        fetch(`/api/qir?year=${selectedQuarter.year}&quarter=${selectedQuarter.quarter}`),
        fetch('/api/dashboard'),
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
    } finally {
      setLoading(false)
    }
  }, [selectedQuarter.year, selectedQuarter.quarter])

  useEffect(() => {
    setActiveDraft(null)
    fetchDrafts()
  }, [fetchDrafts])

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await fetch('/api/qir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate',
          year: selectedQuarter.year,
          quarter: selectedQuarter.quarter,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        alert(data.error || 'Generation failed')
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

  const curatedGrouped = activeDraft
    ? groupByCategory(activeDraft.curated_entries)
    : {}
  const totalCurated = activeDraft?.curated_entries?.length ?? 0

  // Run validation checks if we have a draft
  const validationChecks = activeDraft ? runValidation(activeDraft, complianceSummary) : []
  const hasBlockers = validationChecks.some(c => c.status === 'fail')

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
            className="border rounded px-3 py-2 text-sm"
          >
            {quarterOptions.map((o) => (
              <option key={`${o.year}-${o.quarter}`} value={`${o.year}-${o.quarter}`}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </div>

      {/* ═══ Pre-finalization Validation Checklist ═══ */}
      {activeDraft && activeDraft.status === 'draft' && validationChecks.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pre-Finalization Checklist</h3>
            {hasBlockers ? (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Issues found</span>
            ) : (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">Ready</span>
            )}
          </div>
          <div className="divide-y">
            {validationChecks.map((check) => {
              const style = CHECK_ICONS[check.status]
              return (
                <div key={check.label} className="flex items-center gap-3 px-5 py-2.5">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border ${style.bg} ${style.text}`}>
                    {style.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{check.label}</p>
                    <p className="text-xs text-gray-500">{check.detail}</p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Draft History */}
      {drafts.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b">
            <h3 className="text-sm font-semibold text-gray-500 uppercase">
              Draft History
            </h3>
          </div>
          <div className="divide-y">
            {drafts.map((draft) => (
              <div
                key={draft.id}
                className={`flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-gray-50 ${
                  activeDraft?.id === draft.id ? 'bg-blue-50' : ''
                }`}
                onClick={() => setActiveDraft(draft)}
              >
                <div>
                  <span className="text-sm font-medium">
                    Version {draft.version}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {new Date(draft.created_at).toLocaleDateString()}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    {(draft.curated_entries as QirEntry[])?.length ?? 0} entries
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      draft.status === 'final'
                        ? 'bg-green-100 text-green-800'
                        : 'bg-yellow-100 text-yellow-800'
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
                      className="text-xs px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
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
                      className="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 disabled:opacity-50"
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

      {loading && <p className="text-gray-500">Loading drafts...</p>}

      {/* Active Draft View */}
      {activeDraft && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold">
                Q{activeDraft.quarter} {activeDraft.year} &mdash; v{activeDraft.version}
              </h3>
              <span className="text-sm text-gray-500">
                {totalCurated} curated entries
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded border overflow-hidden text-sm">
                <button
                  onClick={() => setView('curated')}
                  className={`px-3 py-1.5 ${
                    view === 'curated'
                      ? 'bg-gray-900 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Curated
                </button>
                <button
                  onClick={() => setView('full')}
                  className={`px-3 py-1.5 ${
                    view === 'full'
                      ? 'bg-gray-900 text-white'
                      : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  Full Report
                </button>
              </div>
              <a
                href={`/api/qir/export?id=${activeDraft.id}&format=csv`}
                className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50"
              >
                Export CSV
              </a>
              <a
                href={`/api/qir/export?id=${activeDraft.id}&format=text`}
                className="text-xs px-3 py-1.5 border rounded hover:bg-gray-50"
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
        <div className="bg-white rounded-lg shadow p-8 text-center text-gray-500">
          <p className="text-lg mb-2">No drafts yet for {selectedQuarter.label}</p>
          <p className="text-sm">
            Click &quot;Generate Report&quot; to create a QIR draft from summarized
            episodes.
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
