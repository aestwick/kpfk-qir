import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { discoverShows } from '@/lib/archive-discover'

export const dynamic = 'force-dynamic'

/**
 * GET /api/shows/discover — enumerate the active station's full program list from
 * its archive home page. Returns [{ key, name }] for every program the archive
 * publishes (names are display seeds; the resolve step fills the canonical name +
 * category from each feed). Read-only — writes nothing. Thin route: auth +
 * validate + shape; the fetch/parse lives in lib/archive-discover.
 */
export const GET = withStationAuth(async (ctx) => {
  try {
    const { supabase, stationId } = ctx

    const { data: station, error } = await supabase
      .from('stations')
      .select('rss_base_url')
      .eq('id', stationId)
      .maybeSingle()
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!station?.rss_base_url) {
      return NextResponse.json(
        { error: 'This station has no archive feed configured (rss_base_url). Set it before discovering shows.' },
        { status: 400 }
      )
    }

    let shows
    try {
      shows = await discoverShows(station.rss_base_url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'fetch failed'
      return NextResponse.json({ error: `Could not read the archive program list: ${msg}` }, { status: 502 })
    }
    // Zero options means the page loaded but didn't parse as a program list —
    // surface it (likely a markup change), never a silent empty success.
    if (shows.length === 0) {
      return NextResponse.json(
        { error: 'No programs found on the archive home page (its format may have changed).' },
        { status: 502 }
      )
    }

    return NextResponse.json({ shows, total: shows.length })
  } catch (err) {
    console.error('GET /api/shows/discover failed:', err)
    return NextResponse.json({ error: 'Failed to discover shows' }, { status: 500 })
  }
}, { role: 'editor' })
