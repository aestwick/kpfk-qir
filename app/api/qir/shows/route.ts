import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import { getQuarterDateRange } from '@/lib/qir-format'
import { resolveGroupDisplayName, resolveShowGroup } from '@/lib/shows'

export const dynamic = 'force-dynamic'

/**
 * GET /api/qir/shows?year=2026&quarter=1
 * Returns shows that have summarized episodes in the given quarter,
 * with episode counts per show.
 */
export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const { searchParams } = new URL(request.url)
    const year = parseInt(searchParams.get('year') ?? '')
    const quarter = parseInt(searchParams.get('quarter') ?? '')

    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return NextResponse.json({ error: 'Valid year and quarter (1-4) required' }, { status: 400 })
    }

    const { start, end } = getQuarterDateRange(year, quarter)

    // Get all completed episodes in this quarter
    const { data: episodes, error } = await supabase
      .from('episode_log')
      .select('show_key, show_name')
      .eq('station_id', stationId)
      .in('status', ['summarized', 'compliance_checked'])
      .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Look up this station's shows so we can resolve each episode's feed to its
    // logical-show identity (show_group) and display name. Grouping is by the
    // explicit group, never the name — names can differ across sibling feeds.
    // The station's strip prefixes tidy auto-derived names (e.g. drop "KPFK -").
    const [{ data: showKeyRows }, { data: station }] = await Promise.all([
      supabase
        .from('show_keys')
        .select('key, show_name, feed_name, display_name, show_group')
        .eq('station_id', stationId),
      supabase
        .from('stations')
        .select('show_name_strip_prefixes')
        .eq('id', stationId)
        .maybeSingle(),
    ])
    const stripPrefixes = station?.show_name_strip_prefixes ?? null

    const keyMap = new Map((showKeyRows ?? []).map((r) => [r.key, r]))

    // Aggregate by logical show (group). A single show can air on more than one
    // feed, each with its own show_key, so we collapse sibling feeds under their
    // shared group and combine counts. `show_keys` carries every underlying feed
    // so generation can filter on them.
    const showMap = new Map<
      string,
      { group: string; show_keys: string[]; episode_count: number }
    >()
    for (const ep of episodes ?? []) {
      if (!ep.show_key) continue
      const row = keyMap.get(ep.show_key)
      const group = resolveShowGroup({ key: ep.show_key, show_group: row?.show_group ?? null })
      const existing = showMap.get(group)
      if (existing) {
        existing.episode_count++
        if (!existing.show_keys.includes(ep.show_key)) {
          existing.show_keys.push(ep.show_key)
        }
      } else {
        showMap.set(group, { group, show_keys: [ep.show_key], episode_count: 1 })
      }
    }

    // Resolve one canonical display name per group from its feeds (an override on
    // any feed wins for the whole logical show). Fall back to the key when a feed
    // has no show_keys row (e.g. legacy episodes).
    const shows = Array.from(showMap.values())
      .map((s) => {
        const feeds = s.show_keys.map((k) => keyMap.get(k)).filter(Boolean) as NonNullable<
          ReturnType<typeof keyMap.get>
        >[]
        const show_name = feeds.length
          ? resolveGroupDisplayName(feeds, stripPrefixes)
          : s.show_keys[0]
        return { group: s.group, show_name, show_keys: s.show_keys, episode_count: s.episode_count }
      })
      .sort((a, b) => a.show_name.localeCompare(b.show_name))

    return NextResponse.json({ shows })
  } catch (err) {
    console.error('GET /api/qir/shows failed:', err)
    return NextResponse.json({ error: 'Failed to fetch shows' }, { status: 500 })
  }
})
