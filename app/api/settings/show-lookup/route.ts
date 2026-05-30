import { NextRequest, NextResponse } from 'next/server'
import { XMLParser } from 'fast-xml-parser'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { getStation } from '@/lib/stations'

export const dynamic = 'force-dynamic'

// Same parser shape as workers/ingest.ts: keep attributes (for itunes:category
// text="…") and unwrap CDATA (titles/emails are commonly CDATA-wrapped).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
})

// Unwrap a value that may be a plain string or a { __cdata } CDATA node.
function text(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'object' && '__cdata' in (value as Record<string, unknown>)) {
    const c = (value as { __cdata?: unknown }).__cdata
    return c != null ? String(c).trim() || null : null
  }
  return null
}

// itunes:category carries its label in a text attribute and may repeat (one node
// per category). Take the first top-level label; fall back to a plain <category>.
function firstCategory(channel: Record<string, unknown>): string | null {
  const itunes = channel['itunes:category']
  const pickItunes = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null
    const t = (node as Record<string, unknown>)['@_text']
    return t != null ? String(t).trim() || null : null
  }
  if (Array.isArray(itunes)) {
    for (const node of itunes) {
      const label = pickItunes(node)
      if (label) return label
    }
  } else {
    const label = pickItunes(itunes)
    if (label) return label
  }
  // Plain RSS <category> (string, CDATA, or array of either).
  const plain = channel['category']
  if (Array.isArray(plain)) {
    for (const c of plain) {
      const label = text(c)
      if (label) return label
    }
    return null
  }
  return text(plain)
}

// GET /api/settings/show-lookup?key=<feed key>
// Fetches the active station's feed for this key and returns the show-level
// metadata from the channel header so the add-show form can pre-fill it.
// Does NOT touch the FCC issue category — that's decided per episode by the bot.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)

    // Editors+ add shows; gate the lookup the same way the add (POST) is gated.
    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const key = (new URL(request.url).searchParams.get('key') ?? '').trim()
    if (!key) {
      return NextResponse.json({ error: 'key is required' }, { status: 400 })
    }

    const station = await getStation(result.context.stationId)
    if (!station?.rss_base_url) {
      return NextResponse.json(
        { error: 'This station has no RSS base URL configured yet' },
        { status: 400 }
      )
    }

    // rss_base_url is the full prefix up to '?id=' — append the key (see ingest.ts).
    const rssUrl = `${station.rss_base_url}${key}`

    let response: Response
    try {
      response = await fetch(rssUrl, { signal: AbortSignal.timeout(15000) })
    } catch {
      return NextResponse.json({ error: 'Could not reach the feed' }, { status: 502 })
    }

    if (!response.ok) {
      // 404 etc. — most likely a wrong/unknown key. Report found:false, not an error,
      // so the form can say "no feed for that key" without treating it as a failure.
      return NextResponse.json({ found: false, key, status: response.status })
    }

    const xml = await response.text()
    const channel = parser.parse(xml)?.rss?.channel as Record<string, unknown> | undefined
    if (!channel) {
      return NextResponse.json({ found: false, key, reason: 'unparseable feed' })
    }

    const show_name = text(channel['title'])
    const category = firstCategory(channel)
    // <language> is RFC 5646 (e.g. "en-us"); show_keys stores ISO 639-1 ("en").
    const langRaw = text(channel['language'])
    const primary_language = langRaw ? langRaw.slice(0, 2).toLowerCase() : null

    // itunes:owner > itunes:email, falling back to a top-level itunes:email if present.
    const owner = channel['itunes:owner'] as Record<string, unknown> | undefined
    const email = text(owner?.['itunes:email']) ?? text(channel['itunes:email'])

    return NextResponse.json({
      found: true,
      key,
      show_name,
      category,
      primary_language,
      email,
      source_url: rssUrl,
    })
  } catch (err) {
    console.error('GET /api/settings/show-lookup failed:', err)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
}
