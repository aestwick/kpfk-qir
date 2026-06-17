'use client'

import { useEffect, useState, useCallback } from 'react'
import { authedFetch } from '@/lib/api-client'
import { SkeletonBlock } from '@/app/components/skeleton'

interface ApiKeyRow {
  id: number
  name: string
  key_prefix: string
  scopes: string[]
  rate_limit_per_min: number
  active: boolean
  last_used_at: string | null
  created_at: string
}

const ALL_SCOPES = ['qir', 'episodes', 'transcripts', 'shows', 'usage'] as const

const SCOPE_HELP: Record<string, string> = {
  qir: 'Finalized quarterly reports',
  episodes: 'Episode metadata (titles, summaries, dates)',
  transcripts: 'Full transcript text + VTT captions',
  shows: 'Program/show list',
  usage: 'AI cost / usage stats',
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Create form
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['qir', 'episodes', 'shows', 'usage'])
  const [rateLimit, setRateLimit] = useState(60)
  const [creating, setCreating] = useState(false)
  // The raw secret, shown exactly once after creation.
  const [newSecret, setNewSecret] = useState<string | null>(null)

  const fetchKeys = useCallback(async () => {
    setLoading(true)
    const res = await authedFetch('/api/keys')
    if (res.ok) {
      const data = await res.json()
      setKeys(data.keys ?? [])
      setError(null)
    } else {
      setError((await res.json().catch(() => ({}))).error ?? 'Failed to load keys')
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]))
  }

  async function createKey() {
    if (!name.trim()) { setError('Name is required'); return }
    setCreating(true)
    setError(null)
    const res = await authedFetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), scopes, rate_limit_per_min: rateLimit }),
    })
    if (res.ok) {
      const data = await res.json()
      setNewSecret(data.key)
      setName('')
      await fetchKeys()
    } else {
      setError((await res.json().catch(() => ({}))).error ?? 'Failed to create key')
    }
    setCreating(false)
  }

  async function setActive(id: number, active: boolean) {
    const res = await authedFetch('/api/keys', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active }),
    })
    if (res.ok) await fetchKeys()
    else setError((await res.json().catch(() => ({}))).error ?? 'Failed to update key')
  }

  async function deleteKey(id: number) {
    if (!confirm('Permanently delete this key? Any consumer using it will immediately lose access.')) return
    const res = await authedFetch(`/api/keys?id=${id}`, { method: 'DELETE' })
    if (res.ok) await fetchKeys()
    else setError((await res.json().catch(() => ({}))).error ?? 'Failed to delete key')
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h2 className="text-2xl font-bold">API Keys</h2>
        <p className="text-sm text-gray-500 dark:text-warm-400 mt-1">
          Station-scoped keys for the programmatic read API (<code>/api/v1/*</code>). Pass as{' '}
          <code>Authorization: Bearer &lt;key&gt;</code>. Each key reads only this station&apos;s data,
          limited to the scopes you grant.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm dark:bg-red-950 dark:border-red-900 dark:text-red-300">
          {error}
        </div>
      )}

      {/* One-time secret reveal */}
      {newSecret && (
        <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 dark:bg-amber-950 dark:border-amber-800">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
            Copy this key now — it will not be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 bg-white dark:bg-warm-900 border dark:border-warm-700 rounded px-3 py-2 text-sm break-all">
              {newSecret}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(newSecret)}
              className="px-3 py-2 text-sm rounded bg-amber-600 text-white hover:bg-amber-700"
            >
              Copy
            </button>
            <button
              onClick={() => setNewSecret(null)}
              className="px-3 py-2 text-sm rounded border dark:border-warm-700"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark space-y-4">
        <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Create a key</h3>
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Podcast app (captions)"
              className="w-full border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Rate limit / min</label>
            <input
              type="number"
              min={1}
              value={rateLimit}
              onChange={(e) => setRateLimit(parseInt(e.target.value) || 60)}
              className="w-28 border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1.5">Scopes</label>
          <div className="flex flex-wrap gap-3">
            {ALL_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-1.5 text-sm cursor-pointer" title={SCOPE_HELP[scope]}>
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <span>{scope}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-400 dark:text-warm-500 mt-1.5">
            Grant <code>transcripts</code> for caption/VTT access.
          </p>
        </div>
        <button
          onClick={createKey}
          disabled={creating}
          className="px-4 py-2 text-sm rounded bg-kpfk-red text-white hover:opacity-90 disabled:opacity-50"
        >
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </div>

      {/* Keys list */}
      {loading ? (
        <SkeletonBlock />
      ) : (
        <div className="bg-white rounded-lg shadow overflow-hidden dark:bg-surface-raised dark:shadow-card-dark">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Name</th>
                <th className="text-left px-4 py-2 font-medium">Prefix</th>
                <th className="text-left px-4 py-2 font-medium">Scopes</th>
                <th className="text-right px-4 py-2 font-medium">Rate</th>
                <th className="text-left px-4 py-2 font-medium">Last used</th>
                <th className="text-right px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y dark:divide-warm-700">
              {keys.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500 dark:text-warm-400">No API keys yet</td></tr>
              ) : keys.map((k) => (
                <tr key={k.id} className={k.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-2 font-medium">{k.name}</td>
                  <td className="px-4 py-2"><code>{k.key_prefix}…</code></td>
                  <td className="px-4 py-2 text-gray-500 dark:text-warm-400">{k.scopes.join(', ')}</td>
                  <td className="px-4 py-2 text-right">{k.rate_limit_per_min}/min</td>
                  <td className="px-4 py-2 text-gray-500 dark:text-warm-400">
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}
                  </td>
                  <td className="px-4 py-2 text-right space-x-2 whitespace-nowrap">
                    <button onClick={() => setActive(k.id, !k.active)} className="text-blue-600 hover:underline dark:text-blue-400">
                      {k.active ? 'Revoke' : 'Activate'}
                    </button>
                    <button onClick={() => deleteKey(k.id)} className="text-red-600 hover:underline dark:text-red-400">
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
