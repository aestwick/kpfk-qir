import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { resolveShowKeys } from '@/lib/shows-resolve'

export const dynamic = 'force-dynamic'

// Each key is a live archive fetch; cap the request (concurrency/timeout live in
// the lib). Resolve a chunk, review, save, repeat for longer lists.
const MAX_KEYS = 100

/**
 * POST /api/shows/resolve — resolve show keys against the active station's
 * archive feeds. Body: { keys: string[] }.
 *
 * For each key, returns the live feed's channel title (→ show name), category,
 * and item count, so an operator can import shows with just the keys (the
 * names/categories come from the feed). Read-only preview — it writes nothing;
 * the reviewed rows are saved via POST /api/settings. Thin route: auth + validate
 * + shape; the fetch/parse/concurrency lives in lib/shows-resolve.
 */
export const POST = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

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

    const results = await resolveShowKeys(station.rss_base_url, keys)

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
}, { role: 'editor' })
