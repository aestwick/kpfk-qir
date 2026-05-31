import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse, requireRole } from '@/lib/auth'
import { datesForDowInWindow } from '@/lib/compliance-grid'
import { ACTIVE_REVIEW_STATUSES, REVIEW_STATUSES, isReviewStatus } from '@/lib/compliance-status'

export const dynamic = 'force-dynamic'

// GET /api/compliance — list flags with pagination and filters, or stats summary
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)

    // GET /api/compliance?stats=true — active-offense counts by type and
    // severity (investigating + violation), plus how many raw suggestions are
    // still awaiting triage.
    if (searchParams.get('stats') === 'true') {
      const { data, error } = await supabase
        .from('compliance_flags')
        .select('flag_type, severity, review_status, episode_log!inner(station_id)')
        .eq('episode_log.station_id', stationId)

      if (error) throw error

      const byType: Record<string, number> = {}
      const bySeverity: Record<string, number> = {}
      let total = 0
      let pendingTriage = 0
      for (const flag of data ?? []) {
        if (flag.review_status === 'suggested') { pendingTriage++; continue }
        if (flag.review_status === 'dismissed') continue
        byType[flag.flag_type] = (byType[flag.flag_type] ?? 0) + 1
        bySeverity[flag.severity] = (bySeverity[flag.severity] ?? 0) + 1
        total++
      }

      return NextResponse.json({ stats: { byType, bySeverity, total, pendingTriage } })
    }

    // GET /api/compliance?by_show=true — per-show compliance summary
    if (searchParams.get('by_show') === 'true') {
      // Get all compliance-checked episodes
      const { data: episodes, error: epError } = await supabase
        .from('episode_log')
        .select('id, show_name, show_key')
        .eq('station_id', stationId)
        .in('status', ['compliance_checked', 'summarized'])

      if (epError) throw epError

      // Get all active flags (investigating + violation), scoped to this
      // station via the episode_log join.
      const { data: flagRows, error: flagError } = await supabase
        .from('compliance_flags')
        .select('episode_id, flag_type, severity, episode_log!inner(station_id)')
        .eq('episode_log.station_id', stationId)
        .in('review_status', ACTIVE_REVIEW_STATUSES)

      if (flagError) throw flagError

      // Build per-show summary
      const showMap: Record<string, {
        show_name: string
        episodes_checked: number
        episode_ids: Set<number>
        total_flags: number
        critical: number
        warning: number
        info: number
        by_type: Record<string, number>
        flagged_episodes: Set<number>
      }> = {}

      for (const ep of episodes ?? []) {
        const key = ep.show_key
        if (!showMap[key]) {
          showMap[key] = {
            show_name: ep.show_name ?? key,
            episodes_checked: 0,
            episode_ids: new Set(),
            total_flags: 0,
            critical: 0,
            warning: 0,
            info: 0,
            by_type: {},
            flagged_episodes: new Set(),
          }
        }
        showMap[key].episodes_checked++
        showMap[key].episode_ids.add(ep.id)
      }

      for (const flag of flagRows ?? []) {
        // Find which show this episode belongs to
        const ep = (episodes ?? []).find((e) => e.id === flag.episode_id)
        if (!ep) continue
        const key = ep.show_key
        if (!showMap[key]) continue

        showMap[key].total_flags++
        showMap[key].flagged_episodes.add(flag.episode_id)
        if (flag.severity === 'critical') showMap[key].critical++
        else if (flag.severity === 'warning') showMap[key].warning++
        else showMap[key].info++
        showMap[key].by_type[flag.flag_type] = (showMap[key].by_type[flag.flag_type] ?? 0) + 1
      }

      const shows = Object.entries(showMap).map(([show_key, s]) => ({
        show_key,
        show_name: s.show_name,
        episodes_checked: s.episodes_checked,
        episodes_clean: s.episodes_checked - s.flagged_episodes.size,
        episodes_flagged: s.flagged_episodes.size,
        total_flags: s.total_flags,
        critical: s.critical,
        warning: s.warning,
        info: s.info,
        by_type: s.by_type,
        score: s.episodes_checked > 0
          ? Math.round(((s.episodes_checked - s.flagged_episodes.size) / s.episodes_checked) * 100)
          : 100,
      }))

      // Sort by score ascending (worst first), then by total_flags descending
      shows.sort((a, b) => a.score - b.score || b.total_flags - a.total_flags)

      return NextResponse.json({ shows })
    }

    const episodeId = searchParams.get('episode_id')
    const flagType = searchParams.get('flag_type')
    const severity = searchParams.get('severity')
    // status=suggested,investigating,... (comma-separated review statuses).
    // Legacy aliases: unresolved=true → active offenses; resolved=true →
    // dismissed (the closest analog to the old boolean).
    const statusFilter = (searchParams.get('status') ?? '')
      .split(',').map((s) => s.trim()).filter(isReviewStatus)
    if (searchParams.get('unresolved') === 'true') statusFilter.push(...ACTIVE_REVIEW_STATUSES)
    if (searchParams.get('resolved') === 'true') statusFilter.push('dismissed')
    const quarter = searchParams.get('quarter')
    const year = searchParams.get('year')
    const show = searchParams.get('show')
    // Grid drill-through: a day/time cell within a window. dow=0..6 (Sun..Sat);
    // air_start='HH:MM:SS'; win_start/win_end bound the window.
    const dowRaw = searchParams.get('dow')
    const airStart = searchParams.get('air_start')
    const winStart = searchParams.get('win_start')
    const winEnd = searchParams.get('win_end')
    const page = parseInt(searchParams.get('page') ?? '1')
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)
    const offset = (page - 1) * limit
    const allowedSortColumns = ['created_at', 'flag_type', 'severity', 'review_status']
    const sortByRaw = searchParams.get('sort') ?? 'created_at'
    const sortBy = allowedSortColumns.includes(sortByRaw) ? sortByRaw : 'created_at'
    const sortDir = searchParams.get('dir') === 'asc'

    // Build query with count for pagination (scoped to station via the join)
    let query = supabase
      .from('compliance_flags')
      .select('*, episode_log!inner(show_name, show_key, air_date, headline, station_id)', { count: 'exact' })
      .eq('episode_log.station_id', stationId)
      .order(sortBy, { ascending: sortDir })
      .range(offset, offset + limit - 1)

    if (episodeId) query = query.eq('episode_id', parseInt(episodeId))
    if (flagType) query = query.eq('flag_type', flagType)
    if (severity) query = query.eq('severity', severity)
    if (statusFilter.length) query = query.in('review_status', Array.from(new Set(statusFilter)))

    // Filter by quarter/year via the joined episode_log
    if (quarter && year) {
      const q = parseInt(quarter)
      const y = parseInt(year)
      const start = new Date(y, (q - 1) * 3, 1).toISOString().slice(0, 10)
      const end = new Date(y, q * 3, 0).toISOString().slice(0, 10)
      query = query.gte('episode_log.air_date', start).lte('episode_log.air_date', end)
    }

    if (show) {
      query = query.ilike('episode_log.show_name', `%${show}%`)
    }

    // Day/time drill-through from the compliance grid. A day-of-week can't be
    // filtered directly in PostgREST, so expand it to the concrete dates within
    // the window and match air_date IN (...). air_start filters the time slot
    // (hourly cells pass two values via comma; e.g. "06:00:00,06:30:00").
    const isoRe = /^\d{4}-\d{2}-\d{2}$/
    if (dowRaw && winStart && winEnd && isoRe.test(winStart) && isoRe.test(winEnd)) {
      const dow = parseInt(dowRaw)
      if (dow >= 0 && dow <= 6) {
        const dates = datesForDowInWindow(winStart, winEnd, dow)
        // No matching dates → force an empty result rather than ignoring the facet.
        query = query.in('episode_log.air_date', dates.length ? dates : ['0001-01-01'])
      }
    }
    if (airStart) {
      const slots = airStart.split(',').map((s) => s.trim()).filter(Boolean)
      if (slots.length) query = query.in('episode_log.air_start', slots)
    }

    const { data, error, count } = await query
    if (error) throw error

    return NextResponse.json({
      flags: data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        totalPages: Math.ceil((count ?? 0) / limit),
      },
    })
  } catch (err) {
    console.error('GET /api/compliance failed:', err)
    return NextResponse.json({ error: 'Failed to fetch compliance flags' }, { status: 500 })
  }
}

// PATCH /api/compliance — set a flag's review status (single or bulk).
// Body: { id | ids, review_status, resolved_by?, resolved_notes? }
export async function PATCH(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const denied = requireRole(result.context, 'editor')
    if (denied) return stationErrorResponse(denied)

    const body = await request.json()
    const { review_status, resolved_by, resolved_notes } = body

    if (!isReviewStatus(review_status)) {
      return NextResponse.json(
        { error: `review_status must be one of: ${REVIEW_STATUSES.join(', ')}` },
        { status: 400 },
      )
    }

    const update: Record<string, unknown> = { review_status }
    if (resolved_by) update.resolved_by = resolved_by
    if (resolved_notes !== undefined) update.resolved_notes = resolved_notes

    // Bulk: { ids: number[], review_status, ... }
    if (Array.isArray(body.ids)) {
      const { ids } = body
      if (!ids.length) return NextResponse.json({ error: 'ids array required' }, { status: 400 })

      // compliance_flags has no station_id; restrict the update to ids whose
      // episode belongs to this station (resolved via the episode_log join).
      const { data: ownedFlags, error: ownedError } = await supabase
        .from('compliance_flags')
        .select('id, episode_log!inner(station_id)')
        .in('id', ids)
        .eq('episode_log.station_id', stationId)
      if (ownedError) throw ownedError
      const ownedIds = (ownedFlags ?? []).map((f) => f.id)

      if (ownedIds.length === 0) {
        return NextResponse.json({ ok: true, count: 0 })
      }

      const { error } = await supabase
        .from('compliance_flags')
        .update(update)
        .in('id', ownedIds)

      if (error) throw error
      return NextResponse.json({ ok: true, count: ownedIds.length })
    }

    // Single: { id, review_status, ... }
    const { id } = body
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

    // Confirm the flag's episode belongs to this station before updating.
    const { data: ownedFlag, error: ownedError } = await supabase
      .from('compliance_flags')
      .select('id, episode_log!inner(station_id)')
      .eq('id', id)
      .eq('episode_log.station_id', stationId)
      .maybeSingle()
    if (ownedError) throw ownedError
    if (!ownedFlag) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const { error } = await supabase
      .from('compliance_flags')
      .update(update)
      .eq('id', id)

    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('PATCH /api/compliance failed:', err)
    return NextResponse.json({ error: 'Failed to update compliance flag' }, { status: 500 })
  }
}
