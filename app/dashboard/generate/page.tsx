'use client'

import { useEffect, useState, useCallback } from 'react'

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

  const fetchDrafts = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/qir?year=${selectedQuarter.year}&quarter=${selectedQuarter.quarter}`
      )
      if (res.ok) {
        const data = await res.json()
        setDrafts(data.drafts ?? [])
        if (data.drafts?.length && !activeDraft) {
          setActiveDraft(data.drafts[0])
        }
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
    if (action === 'finalize' && !confirm('Finalize this QIR draft? It will be published on the public page.')) return
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
                Q{activeDraft.quarter} {activeDraft.year} — v{activeDraft.version}
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
            <div className="bg-white rounded-lg shadow p-6">
              <pre className="whitespace-pre-wrap text-sm font-mono text-gray-800 max-h-[600px] overflow-y-auto">
                {activeDraft.full_text ?? 'No full report available'}
              </pre>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(curatedGrouped).map(([category, entries]) => (
                <div key={category} className="bg-white rounded-lg shadow">
                  <div className="px-4 py-3 border-b bg-gray-50">
                    <h4 className="text-sm font-semibold uppercase text-gray-600">
                      {category}
                      <span className="ml-2 text-gray-400 font-normal">
                        ({entries.length} entries)
                      </span>
                    </h4>
                  </div>
                  <div className="divide-y">
                    {entries.map((entry) => (
                      <div key={entry.episode_id} className="px-4 py-3">
                        <div className="flex items-start justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">
                              {entry.show_name}
                              {entry.host && (
                                <span className="text-gray-500 font-normal">
                                  {' '}
                                  — {entry.host}
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-gray-500">
                              {entry.air_date} | {entry.start_time} |{' '}
                              {entry.duration} min
                              {entry.guest && ` | Guest: ${entry.guest}`}
                            </p>
                            <p className="text-sm font-medium mt-1">
                              {entry.headline}
                            </p>
                            {editingEntry === entry.episode_id ? (
                              <div className="mt-1">
                                <textarea
                                  value={editSummary}
                                  onChange={(e) => setEditSummary(e.target.value)}
                                  className="w-full border rounded p-2 text-sm"
                                  rows={4}
                                />
                                <div className="flex gap-2 mt-1">
                                  <button
                                    onClick={() =>
                                      handleSaveEditEntry(entry.episode_id)
                                    }
                                    className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={() => setEditingEntry(null)}
                                    className="text-xs px-2 py-1 border rounded"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <p className="text-sm text-gray-700 mt-1">
                                {entry.summary}
                              </p>
                            )}
                          </div>
                          {activeDraft.status === 'draft' && (
                            <div className="flex gap-1 ml-3 shrink-0">
                              <button
                                onClick={() => {
                                  setEditingEntry(entry.episode_id)
                                  setEditSummary(entry.summary)
                                }}
                                className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                              >
                                Edit
                              </button>
                              <button
                                onClick={() =>
                                  handleRemoveEntry(entry.episode_id)
                                }
                                className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                              >
                                Remove
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
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
    </div>
  )
}
