'use client'

import { useEffect, useState, useCallback } from 'react'
import { SkeletonCards, SkeletonBlock } from '@/app/components/skeleton'

interface UsageEntry {
  id: number
  episode_id: number | null
  service: string
  model: string
  operation: string
  input_tokens: number
  output_tokens: number
  duration_seconds: number | null
  estimated_cost: number | null
  created_at: string
}

interface OperationStats {
  cost: number
  count: number
  durationSeconds: number
  inputTokens: number
  outputTokens: number
}

interface Totals {
  groq: number
  openai: number
  total: number
  episodeCount: number
  totalDurationSeconds: number
  totalInputTokens: number
  totalOutputTokens: number
  byOperation: Record<string, OperationStats>
}

function formatCost(n: number) {
  return `$${n.toFixed(4)}`
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.round(seconds % 60)
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function getDefaultDateRange() {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const to = now.toISOString().slice(0, 10)
  return { from, to }
}

export default function UsagePage() {
  const defaults = getDefaultDateRange()
  const [from, setFrom] = useState(defaults.from)
  const [to, setTo] = useState(defaults.to)
  const [entries, setEntries] = useState<UsageEntry[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchUsage = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', `${to}T23:59:59`)
    const res = await fetch(`/api/usage?${params}`)
    if (res.ok) {
      const data = await res.json()
      setEntries(data.entries ?? [])
      setTotals(data.totals)
    }
    setLoading(false)
  }, [from, to])

  useEffect(() => { fetchUsage() }, [fetchUsage])

  // Group entries by date for daily table
  const dailySpend: Record<string, {
    groq: number; openai: number; total: number; count: number;
    durationSeconds: number; inputTokens: number; outputTokens: number
  }> = {}
  for (const entry of entries) {
    const day = entry.created_at.slice(0, 10)
    if (!dailySpend[day]) dailySpend[day] = { groq: 0, openai: 0, total: 0, count: 0, durationSeconds: 0, inputTokens: 0, outputTokens: 0 }
    const cost = Number(entry.estimated_cost) || 0
    const d = dailySpend[day]
    d.total += cost
    d.count++
    d.durationSeconds += Number(entry.duration_seconds) || 0
    d.inputTokens += Number(entry.input_tokens) || 0
    d.outputTokens += Number(entry.output_tokens) || 0
    if (entry.service === 'groq') d.groq += cost
    if (entry.service === 'openai') d.openai += cost
  }

  const sortedDays = Object.keys(dailySpend).sort().reverse()

  const avgCostPerEpisode = totals && totals.episodeCount > 0
    ? totals.total / totals.episodeCount
    : 0

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Usage & Costs</h2>

      {/* Date Range */}
      <div className="flex gap-3 items-center">
        <label className="text-sm text-gray-600 dark:text-warm-400">From</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
        <label className="text-sm text-gray-600 dark:text-warm-400">To</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100" />
      </div>

      {loading ? (
        <div className="space-y-6">
          <SkeletonCards count={5} />
          <SkeletonBlock />
          <SkeletonBlock />
        </div>
      ) : (
        <>
          {/* Summary Cards - Row 1: Costs */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Total Cost</p>
              <p className="text-xl font-bold">{formatCost(totals?.total ?? 0)}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Groq (Transcription)</p>
              <p className="text-xl font-bold">{formatCost(totals?.groq ?? 0)}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">OpenAI (Summarization)</p>
              <p className="text-xl font-bold">{formatCost(totals?.openai ?? 0)}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Episodes Processed</p>
              <p className="text-xl font-bold">{totals?.episodeCount ?? 0}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Avg Cost / Episode</p>
              <p className="text-xl font-bold">{formatCost(avgCostPerEpisode)}</p>
            </div>
          </div>

          {/* Summary Cards - Row 2: Volume */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">API Calls</p>
              <p className="text-xl font-bold">{entries.length}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Audio Transcribed</p>
              <p className="text-xl font-bold">{formatDuration(totals?.totalDurationSeconds ?? 0)}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Input Tokens</p>
              <p className="text-xl font-bold">{formatTokens(totals?.totalInputTokens ?? 0)}</p>
            </div>
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <p className="text-xs text-gray-500 dark:text-warm-400">Output Tokens</p>
              <p className="text-xl font-bold">{formatTokens(totals?.totalOutputTokens ?? 0)}</p>
            </div>
          </div>

          {/* Breakdown by Operation */}
          {totals?.byOperation && Object.keys(totals.byOperation).length > 0 && (
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase mb-3">Breakdown by Operation</h3>
              <table className="w-full text-sm">
                <thead className="border-b dark:border-warm-700">
                  <tr>
                    <th className="text-left py-2 font-medium">Operation</th>
                    <th className="text-right py-2 font-medium">Jobs</th>
                    <th className="text-right py-2 font-medium">Audio</th>
                    <th className="text-right py-2 font-medium">Tokens</th>
                    <th className="text-right py-2 font-medium">Cost</th>
                    <th className="text-right py-2 font-medium w-48">
                      <span className="sr-only">Bar</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-warm-700">
                  {Object.entries(totals.byOperation)
                    .sort(([, a], [, b]) => b.cost - a.cost)
                    .map(([op, stats]) => {
                      const pct = totals.total > 0 ? (stats.cost / totals.total) * 100 : 0
                      const tokenTotal = stats.inputTokens + stats.outputTokens
                      return (
                        <tr key={op}>
                          <td className="py-2 capitalize font-medium">{op}</td>
                          <td className="py-2 text-right">{stats.count}</td>
                          <td className="py-2 text-right text-gray-500 dark:text-warm-400">
                            {stats.durationSeconds > 0 ? formatDuration(stats.durationSeconds) : '—'}
                          </td>
                          <td className="py-2 text-right text-gray-500 dark:text-warm-400">
                            {tokenTotal > 0 ? formatTokens(tokenTotal) : '—'}
                          </td>
                          <td className="py-2 text-right font-medium">{formatCost(stats.cost)}</td>
                          <td className="py-2 pl-4">
                            <div className="bg-gray-200 rounded-full h-3 dark:bg-warm-700">
                              <div className="bg-blue-500 h-3 rounded-full" style={{ width: `${pct}%` }} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}

          {/* Daily Breakdown Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
            <div className="px-4 py-3 border-b dark:border-warm-700">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Daily Breakdown</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Date</th>
                  <th className="text-right px-4 py-2 font-medium">Calls</th>
                  <th className="text-right px-4 py-2 font-medium">Audio</th>
                  <th className="text-right px-4 py-2 font-medium">Tokens</th>
                  <th className="text-right px-4 py-2 font-medium">Groq</th>
                  <th className="text-right px-4 py-2 font-medium">OpenAI</th>
                  <th className="text-right px-4 py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-warm-700">
                {sortedDays.length === 0 ? (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500 dark:text-warm-400">No usage data for this period</td></tr>
                ) : sortedDays.map((day) => {
                  const d = dailySpend[day]
                  const tokenTotal = d.inputTokens + d.outputTokens
                  return (
                    <tr key={day}>
                      <td className="px-4 py-2">{day}</td>
                      <td className="px-4 py-2 text-right">{d.count}</td>
                      <td className="px-4 py-2 text-right text-gray-500 dark:text-warm-400">
                        {d.durationSeconds > 0 ? formatDuration(d.durationSeconds) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right text-gray-500 dark:text-warm-400">
                        {tokenTotal > 0 ? formatTokens(tokenTotal) : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">{formatCost(d.groq)}</td>
                      <td className="px-4 py-2 text-right">{formatCost(d.openai)}</td>
                      <td className="px-4 py-2 text-right font-medium">{formatCost(d.total)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
