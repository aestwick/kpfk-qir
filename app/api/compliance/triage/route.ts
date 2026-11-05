import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { fetchAllRows } from '@/lib/fetch-all'
import { getComplianceChecksEnabled } from '@/lib/settings'
import { getCurrentQuarter } from '@/lib/quarters'
import { tierOf, flagTerm, airedMinute, OPEN_STATUSES, TIERS, type Tier } from '@/lib/compliance-tier'

export const dynamic = 'force-dynamic'

interface Row {
  id: number
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  details: string | null
  timestamp_seconds: number | null
  review_status: string
  resolved_by: string | null
  resolved_notes: string | null
  episode_log: {
    show_name: string | null
    show_key: string
    air_date: string | null
    air_start: string | null
    duration: number | null
    mp3_url: string | null
  }
}

// GET /api/compliance/triage?quarter=2026-4
// Every flag on episodes that aired in the quarter, sorted into triage tiers
// (lib/compliance-tier.ts) with the counts per tier. Tiers are computed here
// over the whole quarter so the counts are true totals, not one page's worth.
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const param = new URL(request.url).searchParams.get('quarter')
    const current = getCurrentQuarter()
    const [y, q] = (param ?? `${current.year}-${current.quarter}`).split('-').map((n) => parseInt(n, 10))
    if (!y || !q || q < 1 || q > 4) {
      return NextResponse.json({ error: 'quarter must look like 2026-4' }, { status: 400 })
    }
    const pad = (n: number) => String(n).padStart(2, '0')
    const start = `${y}-${pad((q - 1) * 3 + 1)}-01`
    const endDate = new Date(Date.UTC(y, q * 3, 0)) // last day of the quarter
    const end = `${y}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}`

    const [rows, checks] = await Promise.all([
      fetchAllRows<any>('triage flags', (from, to) => supabase
        .from('compliance_flags')
        .select('id, episode_id, flag_type, severity, excerpt, details, timestamp_seconds, review_status, resolved_by, resolved_notes, episode_log!inner(station_id, show_name, show_key, air_date, air_start, duration, mp3_url)')
        .eq('episode_log.station_id', stationId)
        .gte('episode_log.air_date', start)
        .lte('episode_log.air_date', end)
        .order('id')
        .range(from, to)),
      getComplianceChecksEnabled(stationId),
    ])

    const counts = Object.fromEntries(TIERS.map((t) => [t, { open: 0, done: 0 }])) as Record<Tier, { open: number; done: number }>
    const flags = (rows as Row[]).map((r) => {
      // A to-one embed; PostgREST may type it as an array.
      const ep = (Array.isArray(r.episode_log) ? r.episode_log[0] : r.episode_log) as Row['episode_log']
      const tier = tierOf({
        flag_type: r.flag_type,
        details: r.details,
        excerpt: r.excerpt,
        timestamp_seconds: r.timestamp_seconds,
        air_start: ep.air_start,
        duration: ep.duration,
      })
      const open = OPEN_STATUSES.has(r.review_status)
      counts[tier][open ? 'open' : 'done']++
      return {
        id: r.id,
        episode_id: r.episode_id,
        tier,
        term: flagTerm(r.details),
        flag_type: r.flag_type,
        severity: r.severity,
        excerpt: r.excerpt,
        details: r.details,
        timestamp_seconds: r.timestamp_seconds,
        review_status: r.review_status,
        resolved_by: r.resolved_by,
        resolved_notes: r.resolved_notes,
        show_name: ep.show_name ?? ep.show_key,
        show_key: ep.show_key,
        air_date: ep.air_date,
        aired_minute: airedMinute(ep.air_start, r.timestamp_seconds),
        mp3_url: ep.mp3_url,
        // A D-tier flag from a check that's now switched off can be retired.
        check_off: checks[r.flag_type] === false,
      }
    })

    // Newest airing first; within an episode, in the order it aired.
    flags.sort((a, b) =>
      (b.air_date ?? '').localeCompare(a.air_date ?? '') ||
      a.episode_id - b.episode_id ||
      (a.timestamp_seconds ?? 0) - (b.timestamp_seconds ?? 0))

    return NextResponse.json({ quarter: `${y}-${q}`, start, end, counts, flags })
  } catch (err) {
    console.error('GET /api/compliance/triage failed:', err)
    return NextResponse.json({ error: 'Failed to load flags' }, { status: 500 })
  }
}
