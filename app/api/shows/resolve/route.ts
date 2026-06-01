import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { parseChannelMeta } from '@/lib/rss'

export const dynamic = 'force-dynamic'

// Bound the work per request: each key is a live archive fetch, so cap the count
// and resolve in small concurrent batches (mirrors the ingest worker's pacing).
const MAX_KEYS = 100
const FETCH_CONCURRENCY = 5
const FETCH_TIMEOUT_MS = 20000

interface ResolveResult {
  key: string
  ok: boolean
  feed_name: string | null
  category: string | null
  episodes: number
  error?: string
}

/**
 * POST /api/shows/resolve — resolve show keys against the active station's
 * archive feeds. Body: { keys: string[] }.
 *
 * For each key, fetches `rss_base_url || key` and returns the channel title
 * (→ show name) + category + item count, so an operator can import shows with
 * just the keys (names/categories come from the live feed). This is a read-only
 * preview — it writes nothing; the reviewed rows are saved via POST /api/settings.
 */
export async function POST(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    // Provisioning action — gate behind editor (same as the save step it feeds).
    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json().catch(() => ({}))
    const rawKeys = Array.isArray(body.keys) ? body.keys : []

    // De-dupe + trim, preserving first-seen order.
    const seen = new Set<string>()
    const keys: string[] = []
    for (const k of rawKeys) {
      const key = String(k ?? '').trim()
      if (key && !seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
    if (keys.length === 0) {
      return NextResponse.json({ error: 'No show keys provided' }, { status: 400 })
    }
    if (keys.length > MAX_KEYS) {
      return NextResponse.json(
        { error: `Too many keys (${keys.length}); resolve at most ${MAX_KEYS} at a time` },
        { status: 400 }
      )
    }

    // The archive base is required to know where feeds live. Fail visibly (never
    // silently) for a station whose archive hasn't been configured yet.
    const { data: station, error: stationErr } = await supabase
      .from('stations')
      .select('rss_base_url')
      .eq('id', stationId)
      .maybeSingle()
    if (stationErr) {
      return NextResponse.json({ error: stationErr.message }, { status: 500 })
    }
    if (!station?.rss_base_url) {
      return NextResponse.json(
        { error: 'This station has no archive feed configured (rss_base_url). Set it before importing from the archive.' },
        { status: 400 }
      )
    }
    // rss_base_url is the full prefix up to '?id=' (see migration 012); the key
    // is appended, exactly as the ingest worker builds its feed URLs.
    const base = station.rss_base_url

    const resolveKey = async (key: string): Promise<ResolveResult> => {
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

    const results: ResolveResult[] = []
    for (let i = 0; i < keys.length; i += FETCH_CONCURRENCY) {
      const batch = keys.slice(i, i + FETCH_CONCURRENCY)
      results.push(...(await Promise.all(batch.map(resolveKey))))
    }

    return NextResponse.json({
      results,
      summary: {
        total: results.length,
        found: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
      },
    })
  } catch (err) {
    console.error('POST /api/shows/resolve failed:', err)
    return NextResponse.json({ error: 'Failed to resolve show keys' }, { status: 500 })
  }
}
