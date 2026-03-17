'use client'

import { useEffect, useState, useCallback } from 'react'

interface Show {
  key: string
  show_name: string
  episode_count: number
}

interface ComplianceFlag {
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  details: string | null
  resolved: boolean
}

interface AuditEpisode {
  id: number
  show_key: string
  show_name: string | null
  status: string
  air_date: string | null
  start_time: string | null
  duration: number | null
  headline: string | null
  host: string | null
  guest: string | null
  summary: string | null
  issue_category: string | null
  error_message: string | null
  compliance_status: string | null
  mp3_url: string
  compliance_flags: ComplianceFlag[]
  actual_cost: number
}

interface AuditData {
  episodes: AuditEpisode[]
  total: number
  statusCounts: Record<string, number>
  issueCategories: Record<string, number>
  processing: {
    needsTranscription: number
    needsSummarization: number
    needsCompliance: number
    estimatedCost: {
      transcription: number
      summarization: number
      compliance: number
      total: number
    }
  }
  actualCostTotal: number
}

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized: 'bg-green-100 text-green-800',
  compliance_checked: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  transcribed: 'Transcribed',
  summarized: 'Summarized',
  compliance_checked: 'Checked',
  failed: 'Failed',
  unavailable: 'Unavailable',
}

const severityColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-700',
  warning: 'bg-yellow-100 text-yellow-700',
  info: 'bg-blue-100 text-blue-700',
}

type Step = 'select' | 'review' | 'report'

export default function ShowAuditPage() {
  const [step, setStep] = useState<Step>('select')

  // Step 1: Selection
  const [shows, setShows] = useState<Show[]>([])
  const [loadingShows, setLoadingShows] = useState(true)
  const [selectedShows, setSelectedShows] = useState<Set<string>>(new Set())
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showSearch, setShowSearch] = useState('')

  // Step 2: Review / Step 3: Report
  const [auditData, setAuditData] = useState<AuditData | null>(null)
  const [loading, setLoading] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [processMessage, setProcessMessage] = useState('')
  const [expandedEpisode, setExpandedEpisode] = useState<number | null>(null)
  const [pollCount, setPollCount] = useState(0)

  // Load shows list
  useEffect(() => {
    fetch('/api/settings?resource=shows')
      .then((r) => r.json())
      .then((data) => {
        setShows(data.shows ?? [])
        setLoadingShows(false)
      })
      .catch(() => setLoadingShows(false))
  }, [])

  // Set default date range to current month
  useEffect(() => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    setDateFrom(new Date(y, m, 1).toISOString().slice(0, 10))
    setDateTo(new Date(y, m + 1, 0).toISOString().slice(0, 10))
  }, [])

  const fetchAudit = useCallback(async () => {
    if (selectedShows.size === 0 || !dateFrom || !dateTo) return
    setLoading(true)
    try {
      const params = new URLSearchParams({
        show_keys: Array.from(selectedShows).join(','),
        from: dateFrom,
        to: dateTo,
      })
      const res = await fetch(`/api/shows/audit?${params}`)
      if (res.ok) {
        const data = await res.json()
        setAuditData(data)
      }
    } catch (err) {
      console.error('Failed to fetch audit:', err)
    }
    setLoading(false)
  }, [selectedShows, dateFrom, dateTo])

  const handleRunAudit = async () => {
    await fetchAudit()
    setStep('review')
  }

  const handleProcessEpisodes = async () => {
    if (!auditData) return
    setProcessing(true)
    setProcessMessage('')

    // Determine which episodes need what
    const needsWork = auditData.episodes.filter(
      (ep) => ep.status === 'pending' || ep.status === 'failed' || ep.status === 'transcribed' || ep.status === 'summarized'
    )
    if (needsWork.length === 0) {
      setProcessMessage('All episodes are already fully processed!')
      setProcessing(false)
      return
    }

    try {
      const res = await fetch('/api/shows/audit/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          episode_ids: needsWork.map((ep) => ep.id),
          stages: ['transcribe', 'summarize', 'compliance'],
        }),
      })
      const data = await res.json()
      if (data.ok) {
        setProcessMessage(data.message)
        // Start polling for updates
        setPollCount(0)
        startPolling()
      } else {
        setProcessMessage(`Error: ${data.error}`)
      }
    } catch {
      setProcessMessage('Failed to queue processing')
    }
    setProcessing(false)
  }

  const startPolling = () => {
    let count = 0
    const interval = setInterval(async () => {
      count++
      await fetchAudit()
      setPollCount(count)
      // Stop after 60 polls (5 minutes at 5s intervals)
      if (count >= 60) clearInterval(interval)
    }, 5000)
    // Store interval ID for cleanup
    return () => clearInterval(interval)
  }

  const handleViewReport = () => {
    setStep('report')
  }

  const handleBack = () => {
    if (step === 'report') setStep('review')
    else if (step === 'review') setStep('select')
  }

  // Month shortcuts
  const setMonth = (monthsBack: number) => {
    const now = new Date()
    const target = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1)
    setDateFrom(target.toISOString().slice(0, 10))
    setDateTo(new Date(target.getFullYear(), target.getMonth() + 1, 0).toISOString().slice(0, 10))
  }

  const monthName = (date: string) => {
    if (!date) return ''
    const d = new Date(date + 'T00:00:00')
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }

  const filteredShows = shows.filter((s) =>
    !showSearch || s.show_name.toLowerCase().includes(showSearch.toLowerCase())
  )

  const toggleShow = (key: string) => {
    setSelectedShows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectAllShows = () => {
    setSelectedShows(new Set(filteredShows.map((s) => s.key)))
  }

  const deselectAllShows = () => {
    setSelectedShows(new Set())
  }

  // Report helpers
  const completedEpisodes = auditData?.episodes.filter(
    (ep) => ep.status === 'summarized' || ep.status === 'compliance_checked'
  ) ?? []

  const needsWorkCount = auditData
    ? (auditData.processing.needsTranscription + auditData.processing.needsSummarization + auditData.processing.needsCompliance)
    : 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Show Audit</h2>
          <p className="text-sm text-gray-500 dark:text-warm-500 mt-1">
            Audit specific shows for a date range &mdash; review, process, and generate reports
          </p>
        </div>
        {step !== 'select' && (
          <button
            onClick={handleBack}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-200 flex items-center gap-1"
          >
            &larr; Back
          </button>
        )}
      </div>

      {/* Step indicators */}
      <div className="flex items-center gap-2 text-sm">
        {(['select', 'review', 'report'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-gray-300 dark:text-warm-600">&rarr;</span>}
            <span
              className={`px-3 py-1 rounded-full text-xs font-medium ${
                step === s
                  ? 'bg-gray-900 text-white dark:bg-kpfk-red'
                  : step === 'report' && s === 'review' || step === 'report' && s === 'select' || step === 'review' && s === 'select'
                  ? 'bg-green-100 text-green-700'
                  : 'bg-gray-100 text-gray-400 dark:bg-warm-800 dark:text-warm-500'
              }`}
            >
              {s === 'select' ? '1. Select Shows' : s === 'review' ? '2. Review & Process' : '3. Audit Report'}
            </span>
          </div>
        ))}
      </div>

      {/* ─── STEP 1: SELECT ─── */}
      {step === 'select' && (
        <div className="space-y-5">
          {/* Date Range */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200 mb-3">Date Range</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              <button onClick={() => setMonth(0)} className="px-3 py-1.5 text-xs rounded-lg border bg-white dark:bg-warm-700 dark:border-warm-600 hover:bg-gray-50 dark:hover:bg-warm-600 font-medium">
                This Month
              </button>
              <button onClick={() => setMonth(1)} className="px-3 py-1.5 text-xs rounded-lg border bg-white dark:bg-warm-700 dark:border-warm-600 hover:bg-gray-50 dark:hover:bg-warm-600 font-medium">
                Last Month
              </button>
              <button onClick={() => setMonth(2)} className="px-3 py-1.5 text-xs rounded-lg border bg-white dark:bg-warm-700 dark:border-warm-600 hover:bg-gray-50 dark:hover:bg-warm-600 font-medium">
                2 Months Ago
              </button>
              <button onClick={() => setMonth(3)} className="px-3 py-1.5 text-xs rounded-lg border bg-white dark:bg-warm-700 dark:border-warm-600 hover:bg-gray-50 dark:hover:bg-warm-600 font-medium">
                3 Months Ago
              </button>
            </div>
            <div className="flex gap-3 items-center">
              <div>
                <label className="text-xs text-gray-500 dark:text-warm-400">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="block mt-1 px-3 py-2 text-sm border rounded-lg dark:bg-warm-700 dark:border-warm-600 dark:text-warm-200"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-warm-400">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="block mt-1 px-3 py-2 text-sm border rounded-lg dark:bg-warm-700 dark:border-warm-600 dark:text-warm-200"
                />
              </div>
              {dateFrom && dateTo && (
                <span className="text-sm text-gray-500 dark:text-warm-400 mt-5">
                  {monthName(dateFrom)} &mdash; {monthName(dateTo)}
                </span>
              )}
            </div>
          </div>

          {/* Show Picker */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200">
                Select Shows ({selectedShows.size} selected)
              </h3>
              <div className="flex gap-2">
                <button onClick={selectAllShows} className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400">
                  Select All
                </button>
                <button onClick={deselectAllShows} className="text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400">
                  Deselect All
                </button>
              </div>
            </div>

            <input
              type="text"
              placeholder="Search shows..."
              value={showSearch}
              onChange={(e) => setShowSearch(e.target.value)}
              className="w-full px-3 py-2 text-sm border rounded-lg mb-3 dark:bg-warm-700 dark:border-warm-600 dark:text-warm-200 dark:placeholder-warm-500"
            />

            {loadingShows ? (
              <div className="py-8 text-center text-gray-400">Loading shows...</div>
            ) : (
              <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-warm-700 border rounded-lg dark:border-warm-600">
                {filteredShows.map((show) => (
                  <label
                    key={show.key}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-warm-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedShows.has(show.key)}
                      onChange={() => toggleShow(show.key)}
                      className="rounded border-gray-300 dark:border-warm-500"
                    />
                    <span className="text-sm text-gray-800 dark:text-warm-200 flex-1">{show.show_name}</span>
                    <span className="text-xs text-gray-400 dark:text-warm-500">{show.episode_count} eps</span>
                  </label>
                ))}
                {filteredShows.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">No shows found</div>
                )}
              </div>
            )}
          </div>

          {/* Run Audit button */}
          <button
            onClick={handleRunAudit}
            disabled={selectedShows.size === 0 || !dateFrom || !dateTo || loading}
            className="w-full py-3 bg-gray-900 text-white rounded-xl font-medium hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-kpfk-red dark:hover:bg-red-700 transition-colors"
          >
            {loading ? 'Loading...' : `Audit ${selectedShows.size} Show${selectedShows.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}

      {/* ─── STEP 2: REVIEW & PROCESS ─── */}
      {step === 'review' && auditData && (
        <div className="space-y-5">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white dark:bg-warm-800 rounded-xl border dark:border-warm-700 p-4">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{auditData.total}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Total Episodes</p>
            </div>
            <div className="bg-white dark:bg-warm-800 rounded-xl border dark:border-warm-700 p-4">
              <p className="text-2xl font-bold text-green-600">{(auditData.statusCounts['summarized'] ?? 0) + (auditData.statusCounts['compliance_checked'] ?? 0)}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Fully Processed</p>
            </div>
            <div className="bg-white dark:bg-warm-800 rounded-xl border dark:border-warm-700 p-4">
              <p className="text-2xl font-bold text-yellow-600">{auditData.processing.needsTranscription + auditData.processing.needsSummarization + auditData.processing.needsCompliance}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Need Processing</p>
            </div>
            <div className="bg-white dark:bg-warm-800 rounded-xl border dark:border-warm-700 p-4">
              <p className="text-2xl font-bold text-gray-900 dark:text-white">${auditData.actualCostTotal.toFixed(3)}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Cost So Far</p>
            </div>
          </div>

          {/* Cost estimate + Process button */}
          {needsWorkCount > 0 && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">Processing Required</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mb-3">
                {auditData.processing.needsTranscription > 0 && (
                  <div className="flex justify-between">
                    <span className="text-amber-700 dark:text-amber-400">Transcription ({auditData.processing.needsTranscription} eps)</span>
                    <span className="font-mono text-amber-800 dark:text-amber-300">${auditData.processing.estimatedCost.transcription.toFixed(3)}</span>
                  </div>
                )}
                {auditData.processing.needsSummarization > 0 && (
                  <div className="flex justify-between">
                    <span className="text-amber-700 dark:text-amber-400">Summarization ({auditData.processing.needsSummarization} eps)</span>
                    <span className="font-mono text-amber-800 dark:text-amber-300">${auditData.processing.estimatedCost.summarization.toFixed(3)}</span>
                  </div>
                )}
                {auditData.processing.needsCompliance > 0 && (
                  <div className="flex justify-between">
                    <span className="text-amber-700 dark:text-amber-400">Compliance ({auditData.processing.needsCompliance} eps)</span>
                    <span className="font-mono text-amber-800 dark:text-amber-300">${auditData.processing.estimatedCost.compliance.toFixed(3)}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center justify-between border-t border-amber-200 dark:border-amber-700 pt-3">
                <div>
                  <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                    Estimated Total: ${auditData.processing.estimatedCost.total.toFixed(3)}
                  </span>
                </div>
                <button
                  onClick={handleProcessEpisodes}
                  disabled={processing}
                  className="px-5 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
                >
                  {processing ? 'Queuing...' : 'Process All Episodes'}
                </button>
              </div>
              {processMessage && (
                <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">{processMessage}</p>
              )}
              {pollCount > 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                  Auto-refreshing... (check {pollCount})
                </p>
              )}
            </div>
          )}

          {needsWorkCount === 0 && auditData.total > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-700 rounded-xl p-5 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-green-800 dark:text-green-300">All Episodes Processed</h3>
                <p className="text-xs text-green-600 dark:text-green-400 mt-1">Ready to view the audit report</p>
              </div>
              <button
                onClick={handleViewReport}
                className="px-5 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
              >
                View Report
              </button>
            </div>
          )}

          {/* Status breakdown */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200 mb-3">Status Breakdown</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(auditData.statusCounts).map(([status, count]) => (
                <span key={status} className={`text-xs px-3 py-1.5 rounded-full font-medium ${statusColors[status] ?? 'bg-gray-100 text-gray-500'}`}>
                  {statusLabels[status] ?? status}: {count}
                </span>
              ))}
            </div>
          </div>

          {/* Episode list */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 overflow-hidden">
            <div className="px-5 py-3 border-b dark:border-warm-700 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200">Episodes ({auditData.total})</h3>
              <button
                onClick={fetchAudit}
                disabled={loading}
                className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
              >
                {loading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-warm-700">
              {auditData.episodes.map((ep) => (
                <div key={ep.id}>
                  <button
                    onClick={() => setExpandedEpisode(expandedEpisode === ep.id ? null : ep.id)}
                    className="w-full px-5 py-3 flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-warm-700 transition-colors text-left"
                  >
                    <span className="text-sm text-gray-500 dark:text-warm-400 w-24 shrink-0 tabular-nums">
                      {ep.air_date ?? '—'}
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${statusColors[ep.status] ?? 'bg-gray-100 text-gray-500'}`}>
                      {statusLabels[ep.status] ?? ep.status}
                    </span>
                    <span className="text-sm text-gray-800 dark:text-warm-200 truncate flex-1">
                      {ep.headline ?? ep.show_name ?? '—'}
                    </span>
                    {ep.duration && (
                      <span className="text-xs text-gray-400 dark:text-warm-500 shrink-0 tabular-nums">{ep.duration}m</span>
                    )}
                    {ep.compliance_flags.length > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium shrink-0">
                        {ep.compliance_flags.length} flag{ep.compliance_flags.length !== 1 ? 's' : ''}
                      </span>
                    )}
                    <span className="text-gray-300 dark:text-warm-600 shrink-0">
                      {expandedEpisode === ep.id ? '▾' : '▸'}
                    </span>
                  </button>

                  {expandedEpisode === ep.id && (
                    <div className="px-5 pb-4 pt-1 bg-gray-50 dark:bg-warm-750 space-y-3 border-t border-gray-100 dark:border-warm-700">
                      {ep.show_name && (
                        <div className="text-xs">
                          <span className="text-gray-400 dark:text-warm-500">Show: </span>
                          <span className="text-gray-700 dark:text-warm-300">{ep.show_name}</span>
                        </div>
                      )}
                      {ep.host && (
                        <div className="text-xs">
                          <span className="text-gray-400 dark:text-warm-500">Host: </span>
                          <span className="text-gray-700 dark:text-warm-300">{ep.host}</span>
                        </div>
                      )}
                      {ep.guest && (
                        <div className="text-xs">
                          <span className="text-gray-400 dark:text-warm-500">Guest: </span>
                          <span className="text-gray-700 dark:text-warm-300">{ep.guest}</span>
                        </div>
                      )}
                      {ep.issue_category && (
                        <div className="text-xs">
                          <span className="text-gray-400 dark:text-warm-500">Category: </span>
                          <span className="text-gray-700 dark:text-warm-300">{ep.issue_category}</span>
                        </div>
                      )}
                      {ep.summary && (
                        <div className="text-xs">
                          <span className="text-gray-400 dark:text-warm-500">Summary: </span>
                          <span className="text-gray-700 dark:text-warm-300">{ep.summary}</span>
                        </div>
                      )}
                      {ep.error_message && (
                        <div className="text-xs bg-red-50 dark:bg-red-900/20 p-2 rounded text-red-600 dark:text-red-400">
                          Error: {ep.error_message}
                        </div>
                      )}
                      {ep.compliance_flags.length > 0 && (
                        <div className="space-y-1">
                          <span className="text-xs text-gray-400 dark:text-warm-500">Compliance Flags:</span>
                          {ep.compliance_flags.map((flag, i) => (
                            <div key={i} className={`text-xs px-2 py-1.5 rounded ${severityColors[flag.severity] ?? 'bg-gray-100 text-gray-600'}`}>
                              <span className="font-medium">{flag.flag_type}</span>
                              {flag.details && <span className="ml-1">&mdash; {flag.details}</span>}
                              {flag.excerpt && <span className="block mt-0.5 opacity-75">"{flag.excerpt}"</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      {ep.actual_cost > 0 && (
                        <div className="text-xs text-gray-400 dark:text-warm-500">
                          Processing cost: ${ep.actual_cost.toFixed(4)}
                        </div>
                      )}
                      <a
                        href={`/dashboard/episodes/${ep.id}`}
                        className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400"
                      >
                        View full episode details &rarr;
                      </a>
                    </div>
                  )}
                </div>
              ))}
              {auditData.episodes.length === 0 && (
                <div className="px-5 py-12 text-center text-gray-400 dark:text-warm-500">
                  No episodes found for the selected shows and date range
                </div>
              )}
            </div>
          </div>

          {/* View Report button at bottom too */}
          {completedEpisodes.length > 0 && (
            <button
              onClick={handleViewReport}
              className="w-full py-3 bg-gray-900 text-white rounded-xl font-medium hover:bg-gray-800 dark:bg-kpfk-red dark:hover:bg-red-700 transition-colors"
            >
              View Audit Report ({completedEpisodes.length} processed episodes)
            </button>
          )}
        </div>
      )}

      {/* ─── STEP 3: AUDIT REPORT ─── */}
      {step === 'report' && auditData && (
        <div className="space-y-5">
          {/* Report header */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-6">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-1">
              Show Audit Report
            </h3>
            <p className="text-sm text-gray-500 dark:text-warm-400">
              {monthName(dateFrom)} &mdash; {monthName(dateTo)}
              {' '}&middot;{' '}
              {Array.from(selectedShows).length} show{selectedShows.size !== 1 ? 's' : ''}
              {' '}&middot;{' '}
              {completedEpisodes.length} episode{completedEpisodes.length !== 1 ? 's' : ''}
            </p>
          </div>

          {/* Issue Categories */}
          {Object.keys(auditData.issueCategories).length > 0 && (
            <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200 mb-3">Issues Covered</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(auditData.issueCategories)
                  .sort((a, b) => b[1] - a[1])
                  .map(([category, count]) => (
                    <span key={category} className="text-xs px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium">
                      {category} ({count})
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Compliance overview */}
          {(() => {
            const allFlags = completedEpisodes.flatMap((ep) => ep.compliance_flags)
            const unresolvedFlags = allFlags.filter((f) => !f.resolved)
            const criticalCount = unresolvedFlags.filter((f) => f.severity === 'critical').length
            const warningCount = unresolvedFlags.filter((f) => f.severity === 'warning').length

            return (
              <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200 mb-3">Compliance Summary</h3>
                {unresolvedFlags.length === 0 ? (
                  <p className="text-sm text-green-600 dark:text-green-400">No unresolved compliance flags</p>
                ) : (
                  <div className="flex gap-4">
                    <span className="text-sm text-red-600">Critical: {criticalCount}</span>
                    <span className="text-sm text-yellow-600">Warnings: {warningCount}</span>
                    <span className="text-sm text-blue-600">Info: {unresolvedFlags.length - criticalCount - warningCount}</span>
                  </div>
                )}
              </div>
            )
          })()}

          {/* Cost summary */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 p-5">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200 mb-3">Processing Cost</h3>
            <p className="text-2xl font-bold text-gray-900 dark:text-white">${auditData.actualCostTotal.toFixed(3)}</p>
          </div>

          {/* Episode-by-episode report */}
          <div className="bg-white dark:bg-warm-800 rounded-xl shadow-sm border dark:border-warm-700 overflow-hidden">
            <div className="px-5 py-3 border-b dark:border-warm-700">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-warm-200">Episode Details</h3>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-warm-700">
              {completedEpisodes.map((ep) => (
                <div key={ep.id} className="px-5 py-4 space-y-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium text-gray-800 dark:text-warm-200">
                      {ep.air_date}
                    </span>
                    <span className="text-sm text-gray-600 dark:text-warm-300">
                      {ep.show_name}
                    </span>
                    {ep.issue_category && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300 font-medium">
                        {ep.issue_category}
                      </span>
                    )}
                    {ep.compliance_flags.filter((f) => !f.resolved).length > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium">
                        {ep.compliance_flags.filter((f) => !f.resolved).length} flag{ep.compliance_flags.filter((f) => !f.resolved).length !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {ep.headline && (
                    <p className="text-sm font-medium text-gray-900 dark:text-white">{ep.headline}</p>
                  )}
                  {ep.summary && (
                    <p className="text-xs text-gray-600 dark:text-warm-400 leading-relaxed">{ep.summary}</p>
                  )}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-warm-500">
                    {ep.host && <span>Host: {ep.host}</span>}
                    {ep.guest && <span>Guest: {ep.guest}</span>}
                    {ep.duration && <span>{ep.duration} min</span>}
                    {ep.start_time && <span>Aired: {ep.start_time}</span>}
                  </div>
                  {ep.compliance_flags.filter((f) => !f.resolved).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {ep.compliance_flags.filter((f) => !f.resolved).map((flag, i) => (
                        <span key={i} className={`text-[10px] px-2 py-0.5 rounded ${severityColors[flag.severity]}`}>
                          {flag.flag_type}: {flag.details ?? flag.excerpt ?? ''}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {completedEpisodes.length === 0 && (
                <div className="px-5 py-12 text-center text-gray-400 dark:text-warm-500">
                  No processed episodes to show. Go back and process episodes first.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
