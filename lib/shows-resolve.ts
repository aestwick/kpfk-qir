import { parseChannelMeta } from './rss'

// Each key is a live archive fetch, so resolve in small concurrent batches
// (matches the ingest worker's CONCURRENCY=5 / 30s feed timeout pacing).
const FETCH_CONCURRENCY = 5
const FETCH_TIMEOUT_MS = 30000

export interface ShowKeyResolution {
  key: string
  ok: boolean
  feed_name: string | null
  category: string | null
  episodes: number
  error?: string
}

/**
 * Resolve a single show key against its archive feed. `base` is the station's
 * rss_base_url (the full prefix up to '?id='); the key is appended exactly as the
 * ingest worker builds feed URLs. Read-only: fetches and parses, never writes.
 * Never throws — a failed/unreachable feed comes back as `ok: false` with a reason.
 */
async function resolveOne(base: string, key: string): Promise<ShowKeyResolution> {
  const url = `${base}${key}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) {
      return { key, ok: false, feed_name: null, category: null, episodes: 0, error: `feed returned ${res.status}` }
    }
    const xml = await res.text()
    const meta = parseChannelMeta(xml)
    // A reachable URL that isn't actually a feed (no title, no items) is "not found".
    if (!meta.title && meta.itemCount === 0) {
      return { key, ok: false, feed_name: null, category: null, episodes: 0, error: 'not a valid feed' }
    }
    return { key, ok: true, feed_name: meta.title, category: meta.category, episodes: meta.itemCount }
  } catch (err) {
    const msg = err instanceof Error
      ? (err.name === 'TimeoutError' ? 'timed out' : err.message)
      : 'fetch failed'
    return { key, ok: false, feed_name: null, category: null, episodes: 0, error: msg }
  }
}

/**
 * Resolve show keys against a station's archive feeds, in bounded concurrent
 * batches. Returns one result per input key, in input order. Callers are
 * responsible for de-duping/validating the key list and for supplying a non-empty
 * base (this is the lib half of POST /api/shows/resolve).
 */
export async function resolveShowKeys(base: string, keys: string[]): Promise<ShowKeyResolution[]> {
  const results: ShowKeyResolution[] = []
  for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
    const batch = keys.slice(i, i + FETCH_CONCURRENCY)
    results.push(...(await Promise.all(batch.map((k) => resolveOne(base, k)))))
  }
  return results
}
