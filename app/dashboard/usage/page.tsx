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

interface Totals {
  groq: number
  openai: number
  total: number
  episodeCount: number
  byOperation: Record<string, number>
}

function formatCost(n: number) {
  return `$${n.toFixed(4)}`
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

  // Group entries by date for daily spend table
  const dailySpend: Record<string, { groq: number; openai: number; total: number; count: number }> = {}
  for (const entry of entries) {
    const day = entry.created_at.slice(0, 10)
    if (!dailySpend[day]) dailySpend[day] = { groq: 0, openai: 0, total: 0, count: 0 }
    const cost = Number(entry.estimated_cost) || 0
    dailySpend[day].total += cost
    dailySpend[day].count++
    if (entry.service === 'groq') dailySpend[day].groq += cost
    if (entry.service === 'openai') dailySpend[day].openai += cost
  }

  const sortedDays = Object.keys(dailySpend).sort().reverse()

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
          {/* Summary Cards */}
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
              <p className="text-xs text-gray-500 dark:text-warm-400">API Calls</p>
              <p className="text-xl font-bold">{entries.length}</p>
            </div>
          </div>

          {/* Cost by Operation */}
          {totals?.byOperation && Object.keys(totals.byOperation).length > 0 && (
            <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase mb-3">Cost by Operation</h3>
              <div className="space-y-2">
                {Object.entries(totals.byOperation).map(([op, cost]) => {
                  const pct = totals.total > 0 ? (cost / totals.total) * 100 : 0
                  return (
                    <div key={op} className="flex items-center gap-3">
                      <span className="text-sm w-24 capitalize">{op}</span>
                      <div className="flex-1 bg-gray-200 rounded-full h-3 dark:bg-warm-700">
                        <div className="bg-blue-500 h-3 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-sm font-medium w-20 text-right">{formatCost(cost)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Daily Spend Table */}
          <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
            <div className="px-4 py-3 border-b dark:border-warm-700">
              <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Daily Spend</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Date</th>
                  <th className="text-right px-4 py-2 font-medium">Groq</th>
                  <th className="text-right px-4 py-2 font-medium">OpenAI</th>
                  <th className="text-right px-4 py-2 font-medium">Total</th>
                  <th className="text-right px-4 py-2 font-medium">Calls</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-warm-700">
                {sortedDays.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500 dark:text-warm-400">No usage data for this period</td></tr>
                ) : sortedDays.map((day) => (
                  <tr key={day}>
                    <td className="px-4 py-2">{day}</td>
                    <td className="px-4 py-2 text-right">{formatCost(dailySpend[day].groq)}</td>
                    <td className="px-4 py-2 text-right">{formatCost(dailySpend[day].openai)}</td>
                    <td className="px-4 py-2 text-right font-medium">{formatCost(dailySpend[day].total)}</td>
                    <td className="px-4 py-2 text-right">{dailySpend[day].count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
