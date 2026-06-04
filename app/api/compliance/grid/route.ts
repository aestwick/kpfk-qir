import { NextResponse } from 'next/server'
import { withStationAuth } from '@/lib/auth'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  bucketEpisodes,
  buildColumns,
  buildMatrix,
  daysBetween,
  weeksInWindow,
} from '@/lib/compliance-grid'
import type { GridAiring, GridWindow } from '@/lib/types'
import { ACTIVE_REVIEW_STATUSES } from '@/lib/compliance-status'

export const dynamic = 'force-dynamic'

// The 6 compliance_flags types; `summary_discrepancy` is a synthetic 7th source
// (episode_log.compliance_report), not a real flag row. See spec §6.1.
const FLAG_TYPES = new Set([
  'profanity', 'station_id_missing', 'technical', 'payola_plugola', 'sponsor_id', 'indecency',
])
const DISCREPANCY_TYPE = 'summary_discrepancy'

interface GridFilters {
  includeResolved: boolean
  includeDiscrepancies: boolean
  flagTypes: string[] // empty = all
  severities: string[] // empty = all
}

// GET /api/compliance/grid — offense-density grids for one or two windows.
// Single: ?start=&end=  ·  Compare: ?compare=true&a_start=&a_end=&b_start=&b_end=
export const GET = withStationAuth(async (ctx, request) => {
  try {
    const { supabase, stationId } = ctx

    const { searchParams } = new URL(request.url)

    const flagTypes = (searchParams.get('flag_type') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const severities = (searchParams.get('severity') ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean)
    const filters: GridFilters = {
      includeResolved: searchParams.get('include_resolved') === 'true',
      // discrepancies on by default; suppressed when narrowing to specific flag
      // types that don't include it, or when the severity facet is narrowed.
      includeDiscrepancies: searchParams.get('include_discrepancies') !== 'false',
      flagTypes,
      severities,
    }

    const meta = {
      includeResolved: filters.includeResolved,
      includeDiscrepancies: shouldCountDiscrepancies(filters),
      flagTypes,
      severities,
    }

    if (searchParams.get('compare') === 'true') {
      const a = parseWindow(searchParams, 'a_')
      const b = parseWindow(searchParams, 'b_')
      if (!a || !b) {
        return NextResponse.json({ error: 'compare requires a_start/a_end/b_start/b_end' }, { status: 400 })
      }
      const [winA, winB] = await Promise.all([
        buildWindow(supabase, stationId, a.start, a.end, filters),
        buildWindow(supabase, stationId, b.start, b.end, filters),
      ])
      return NextResponse.json({ meta, a: winA, b: winB })
    }

    const single = parseWindow(searchParams, '')
    if (!single) {
      return NextResponse.json({ error: 'start and end (YYYY-MM-DD) are required' }, { status: 400 })
    }
    const window = await buildWindow(supabase, stationId, single.start, single.end, filters)
    return NextResponse.json({ meta, window })
  } catch (err) {
    console.error('GET /api/compliance/grid failed:', err)
    return NextResponse.json({ error: 'Failed to build compliance grid' }, { status: 500 })
  }
})

function parseWindow(params: URLSearchParams, prefix: string): { start: string; end: string } | null {
  const start = params.get(`${prefix}start`)
  const end = params.get(`${prefix}end`)
  const isoRe = /^\d{4}-\d{2}-\d{2}$/
  if (!start || !end || !isoRe.test(start) || !isoRe.test(end) || start > end) return null
  return { start, end }
}

// A summary_discrepancy is a metadata-quality note, not an FCC flag. Count it
// only when not narrowing to specific flag types (unless it's explicitly named)
// and not narrowing the severity facet (discrepancies carry no severity).
function shouldCountDiscrepancies(f: GridFilters): boolean {
  if (!f.includeDiscrepancies) return false
  if (f.severities.length > 0) return false
  if (f.flagTypes.length > 0) return f.flagTypes.includes(DISCREPANCY_TYPE)
  return true
}

// Resolve one window into a GridWindow: load airings + offense counts, then
// reduce to heatmap + matrix via the pure helpers.
async function buildWindow(
  supabase: SupabaseClient,
  stationId: string,
  start: string,
  end: string,
  filters: GridFilters,
): Promise<GridWindow> {
  // Episodes that aired in the window (station-scoped, with airing metadata).
  const { data: episodes, error: epError } = await supabase
    .from('episode_log')
    .select('id, show_key, show_name, air_date, air_start, compliance_report')
    .eq('station_id', stationId)
    .gte('air_date', start)
    .lte('air_date', end)
    .not('air_date', 'is', null)
  if (epError) throw epError

  const epList = episodes ?? []
  const epIds = epList.map((e) => e.id)

  // Flag offense counts per episode. Scoped to station via the episode_log join,
  // mirroring app/api/compliance/route.ts.
  const flagCounts = new Map<number, number>()
  if (epIds.length > 0) {
    let flagQuery = supabase
      .from('compliance_flags')
      .select('episode_id, flag_type, severity, review_status, episode_log!inner(station_id)')
      .eq('episode_log.station_id', stationId)
      .in('episode_id', epIds)
    // Default: only active offenses (investigating + violation). includeResolved
    // widens it to every flag, including suggested + dismissed.
    if (!filters.includeResolved) flagQuery = flagQuery.in('review_status', ACTIVE_REVIEW_STATUSES)
    if (filters.flagTypes.length > 0) {
      const realTypes = filters.flagTypes.filter((t) => FLAG_TYPES.has(t))
      // If the only requested type is summary_discrepancy, no flag rows match.
      flagQuery = flagQuery.in('flag_type', realTypes.length > 0 ? realTypes : ['__none__'])
    }
    if (filters.severities.length > 0) flagQuery = flagQuery.in('severity', filters.severities)

    const { data: flagRows, error: flagError } = await flagQuery
    if (flagError) throw flagError
    for (const f of flagRows ?? []) {
      flagCounts.set(f.episode_id, (flagCounts.get(f.episode_id) ?? 0) + 1)
    }
  }

  const countDiscrepancies = shouldCountDiscrepancies(filters)

  const airings: GridAiring[] = epList.map((ep) => {
    const flags = flagCounts.get(ep.id) ?? 0
    const discrepancy = countDiscrepancies && ep.compliance_report?.trim() ? 1 : 0
    return {
      show_key: ep.show_key,
      show_name: ep.show_name,
      air_date: ep.air_date as string,
      air_start: ep.air_start,
      offenses: flags + discrepancy,
    }
  })

  const rangeDays = daysBetween(start, end)
  const columns = buildColumns(start, end)
  const heatmap = bucketEpisodes(airings)
  const matrix = buildMatrix(airings, columns)

  let totalOffenses = 0
  let unplacedOffenses = 0
  let airingsCounted = 0
  for (const a of airings) {
    if (a.offenses <= 0) continue
    totalOffenses += a.offenses
    airingsCounted++
    if (!a.air_start) unplacedOffenses += a.offenses
  }

  return {
    start,
    end,
    rangeDays,
    weeks: weeksInWindow(rangeDays),
    heatmap,
    columns,
    matrix,
    totalOffenses,
    airingsCounted,
    unplacedOffenses,
  }
}
