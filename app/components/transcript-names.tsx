'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { authedFetch } from '@/lib/api-client'
import { episodeHref } from '@/lib/nav'
import { useToast } from '@/app/components/toast'
import type { ShowOption } from '@/app/components/transcript-corrections'

interface VocabName {
  id: number
  show_key: string | null
  name: string
  source: 'manual' | 'confessor' | 'cms' | 'website' | 'correction'
  active: boolean
}

interface Suggestion {
  id: number
  show_key: string | null
  variant: string
  correct: string
  occurrences: number
  episodes: number
  sample_episode_id: number | null
  sample_text: string | null
}

const SOURCE_LABEL: Record<VocabName['source'], string> = {
  manual: 'added here',
  confessor: 'Confessor',
  cms: 'website',
  website: 'website',
  correction: 'approved fix',
}

/**
 * Settings → Corrections: the per-show name list (correct spellings of hosts
 * and regulars) and the queue of suggested corrections the nightly miner found.
 * Approving a suggestion creates a rule (this show only unless widened) and
 * fixes past transcripts; nothing is rewritten without that click.
 */
export function TranscriptNames({
  shows,
  hintEnabled,
  onSaved,
}: {
  shows: ShowOption[]
  hintEnabled: boolean
  /** Called after an approval creates a rule, so the rules table refreshes. */
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [names, setNames] = useState<VocabName[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [hint, setHint] = useState(hintEnabled)
  const [showKey, setShowKey] = useState('')
  const [newNames, setNewNames] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState<number | null>(null)
  const showLabel = useMemo(() => new Map(shows.map((s) => [s.key, s.label])), [shows])

  useEffect(() => setHint(hintEnabled), [hintEnabled])

  const load = useCallback(async () => {
    const [n, s] = await Promise.all([
      authedFetch('/api/corrections/vocabulary'),
      authedFetch('/api/corrections/suggestions'),
    ])
    if (n.ok) setNames((await n.json()).names ?? [])
    if (s.ok) setSuggestions((await s.json()).suggestions ?? [])
  }, [])

  useEffect(() => {
    load().catch(() => toast('error', 'Failed to load names'))
  }, [load, toast])

  async function toggleHint() {
    const next = !hint
    setHint(next)
    const res = await authedFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'vocabulary_hint_enabled', value: next }),
    }).catch(() => null)
    if (!res?.ok) {
      setHint(!next)
      toast('error', 'Failed to save the name hint setting')
    }
  }

  async function addNames() {
    if (!newNames.trim()) return
    const res = await authedFetch('/api/corrections/vocabulary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show_key: showKey || null, names: newNames }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return toast('error', data.error ?? 'Failed to add names')
    toast('success', `Added ${data.added}${data.reactivated ? `, switched ${data.reactivated} back on` : ''}`)
    setNewNames('')
    load()
  }

  async function toggleName(n: VocabName) {
    await authedFetch('/api/corrections/vocabulary', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: n.id, active: !n.active }),
    })
    load()
  }

  async function decide(s: Suggestion, action: 'approve' | 'reject', scope: 'show' | 'station' = 'show') {
    setBusy(s.id)
    try {
      const res = await authedFetch('/api/corrections/suggestions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, action, scope }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return toast('error', data.error ?? 'Failed')
      toast('success', action === 'approve' ? `Rule added — fixing past transcripts` : 'Dismissed')
      load()
      if (action === 'approve') onSaved()
    } finally {
      setBusy(null)
    }
  }

  // Group names by show for display; station-wide first.
  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const m = new Map<string, VocabName[]>()
    for (const n of names) {
      const label = n.show_key ? showLabel.get(n.show_key) ?? n.show_key : 'All shows (station-wide)'
      if (q && !label.toLowerCase().includes(q) && !n.name.toLowerCase().includes(q)) continue
      m.set(label, [...(m.get(label) ?? []), n])
    }
    return Array.from(m.entries()).sort(([a], [b]) =>
      a.startsWith('All shows') ? -1 : b.startsWith('All shows') ? 1 : a.localeCompare(b),
    )
  }, [names, filter, showLabel])

  return (
    <div className="space-y-4">
      {/* Suggested corrections */}
      <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-3">
        <div>
          <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">
            Suggested fixes {suggestions.length > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">({suggestions.length})</span>}
          </h3>
          <p className="text-xs text-gray-500 dark:text-warm-400 mt-1">
            Found overnight: a show&rsquo;s known name spelled another way, again and again. Approve to fix it in that
            show&rsquo;s transcripts (past and future). Nothing changes until you approve.
          </p>
        </div>
        {suggestions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-warm-400">No suggestions right now.</p>
        ) : (
          <div className="divide-y dark:divide-warm-700">
            {suggestions.map((s) => (
              <div key={s.id} className="py-2 flex flex-col sm:flex-row sm:items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">
                    <span className="font-mono line-through text-red-700 dark:text-red-300">{s.variant}</span>
                    {' → '}
                    <span className="font-mono text-green-700 dark:text-green-300">{s.correct}</span>
                    <span className="text-xs text-gray-500 dark:text-warm-400 ml-2">
                      {s.show_key ? showLabel.get(s.show_key) ?? s.show_key : 'All shows'} · {s.occurrences}× in {s.episodes} episode{s.episodes === 1 ? '' : 's'}
                    </span>
                  </p>
                  {s.sample_text && (
                    <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5 truncate" title={s.sample_text}>
                      {s.sample_text}
                      {s.sample_episode_id && (
                        <a href={episodeHref(s.sample_episode_id, '/dashboard/settings?tab=corrections')} className="ml-1 text-blue-600 dark:text-blue-400 hover:underline">listen</a>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    disabled={busy === s.id}
                    onClick={() => decide(s, 'approve')}
                    className="px-3 py-1 text-xs bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy === s.id}
                    onClick={() => decide(s, 'approve', 'station')}
                    className="px-3 py-1 text-xs border border-green-600 text-green-700 dark:text-green-300 rounded hover:bg-green-50 dark:hover:bg-warm-700 disabled:opacity-50"
                    title="Fix this spelling on every show, not just this one"
                  >
                    Approve for all shows
                  </button>
                  <button
                    disabled={busy === s.id}
                    onClick={() => decide(s, 'reject')}
                    className="px-3 py-1 text-xs text-gray-600 dark:text-warm-300 hover:underline disabled:opacity-50"
                  >
                    Not a mistake
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Name list */}
      <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="flex-1">
            <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Show names</h3>
            <p className="text-xs text-gray-500 dark:text-warm-400 mt-1">
              The correct spelling of each show&rsquo;s hosts and regulars. Used to spot misspellings (above) and,
              when the hint is on, sent to Whisper so it spells them right the first time. Hosts added on the
              website arrive here automatically each night.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm shrink-0" title="Talk shows only — never music">
            <input type="checkbox" checked={hint} onChange={toggleHint} />
            Send names to Whisper (talk shows)
          </label>
        </div>

        <div className="flex flex-col sm:flex-row gap-2">
          <select
            value={showKey}
            onChange={(e) => setShowKey(e.target.value)}
            className="border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 sm:w-64"
          >
            <option value="">All shows (station-wide)</option>
            {shows.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={newNames}
            onChange={(e) => setNewNames(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addNames() }}
            placeholder="e.g. Harvey Wasserman, Kevin Kamps"
            className="flex-1 border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
          />
          <button onClick={addNames} className="px-4 py-1.5 text-sm bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700">
            Add
          </button>
        </div>

        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by show or name…"
          className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
        />

        <div className="max-h-[28rem] overflow-y-auto divide-y dark:divide-warm-700">
          {grouped.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-warm-400 py-3">No names yet.</p>
          ) : grouped.map(([label, list]) => (
            <div key={label} className="py-2">
              <p className="text-xs font-medium text-gray-600 dark:text-warm-300 mb-1">{label}</p>
              <div className="flex flex-wrap gap-1.5">
                {list.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => toggleName(n)}
                    title={`${n.active ? 'Click to switch off' : 'Off — click to switch on'} · from ${SOURCE_LABEL[n.source]}`}
                    className={`text-xs px-2 py-0.5 rounded border ${n.active
                      ? 'border-gray-300 dark:border-warm-600 text-gray-800 dark:text-warm-100'
                      : 'border-dashed border-gray-300 dark:border-warm-600 text-gray-400 dark:text-warm-500 line-through'}`}
                  >
                    {n.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
