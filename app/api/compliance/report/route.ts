import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

// GET /api/compliance/report — compliance flags grouped by show > episode
// Query params: flag_type, severity, quarter (e.g. "2026-1"), unresolved=true
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const flagType = searchParams.get('flag_type')
    const severity = searchParams.get('severity')
    const quarter = searchParams.get('quarter') // e.g. "2026-1"
    const unresolvedOnly = searchParams.get('unresolved') === 'true'
    const show = searchParams.get('show')

    // Build query
    let query = supabaseAdmin
      .from('compliance_flags')
      .select('*, episode_log!inner(show_name, show_key, air_date, air_time, duration, headline, host, status)')
      .order('created_at', { ascending: false })

    if (flagType) query = query.eq('flag_type', flagType)
    if (severity) query = query.eq('severity', severity)
    if (unresolvedOnly) query = query.eq('resolved', false)
    if (show) query = query.ilike('episode_log.show_name', `%${show}%`)

    // Filter by quarter via the joined episode_log
    if (quarter) {
      const [y, q] = quarter.split('-')
      const qNum = parseInt(q)
      const yNum = parseInt(y)
      if (!isNaN(qNum) && !isNaN(yNum)) {
        const start = new Date(yNum, (qNum - 1) * 3, 1).toISOString().slice(0, 10)
        const end = new Date(yNum, qNum * 3, 0).toISOString().slice(0, 10)
        query = query.gte('episode_log.air_date', start).lte('episode_log.air_date', end)
      }
    }

    const { data: flags, error } = await query
    if (error) throw error

    // Group: show_key → episodes → flags
    interface EpisodeInfo {
      episode_id: number
      show_name: string
      show_key: string
      air_date: string | null
      air_time: string | null
      duration: number | null
      headline: string | null
      host: string | null
      flags: typeof flags
    }

    interface ShowGroup {
      show_name: string
      show_key: string
      episodes: Map<number, EpisodeInfo>
      total_flags: number
      critical: number
      warning: number
      info: number
    }

    const showMap = new Map<string, ShowGroup>()

    for (const flag of flags ?? []) {
      const ep = flag.episode_log as any
      const key = ep.show_key as string

      if (!showMap.has(key)) {
        showMap.set(key, {
          show_name: ep.show_name ?? key,
          show_key: key,
          episodes: new Map(),
          total_flags: 0,
          critical: 0,
          warning: 0,
          info: 0,
        })
      }

      const showGroup = showMap.get(key)!
      showGroup.total_flags++
      if (flag.severity === 'critical') showGroup.critical++
      else if (flag.severity === 'warning') showGroup.warning++
      else showGroup.info++

      if (!showGroup.episodes.has(flag.episode_id)) {
        showGroup.episodes.set(flag.episode_id, {
          episode_id: flag.episode_id,
          show_name: ep.show_name ?? key,
          show_key: key,
          air_date: ep.air_date,
          air_time: ep.air_time,
          duration: ep.duration,
          headline: ep.headline,
          host: ep.host,
          flags: [],
        })
      }

      const epGroup = showGroup.episodes.get(flag.episode_id)!
      ;(epGroup.flags as any[]).push({
        id: flag.id,
        flag_type: flag.flag_type,
        severity: flag.severity,
        excerpt: flag.excerpt,
        details: flag.details,
        timestamp_seconds: flag.timestamp_seconds,
        resolved: flag.resolved,
        resolved_by: flag.resolved_by,
        resolved_notes: flag.resolved_notes,
        created_at: flag.created_at,
      })
    }

    // Convert to serializable arrays, sort by severity (critical first)
    const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }

    const shows = Array.from(showMap.values())
      .map((s) => ({
        ...s,
        episodes: Array.from(s.episodes.values()).map((ep) => ({
          ...ep,
          flags: (ep.flags as any[]).sort(
            (a: any, b: any) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)
          ),
        })).sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? '')),
      }))
      .sort((a, b) => a.critical !== b.critical ? b.critical - a.critical : b.total_flags - a.total_flags)

    const totalFlags = shows.reduce((sum, s) => sum + s.total_flags, 0)

    return NextResponse.json({
      shows,
      summary: {
        total_flags: totalFlags,
        total_shows: shows.length,
        total_episodes: shows.reduce((sum, s) => sum + s.episodes.length, 0),
        critical: shows.reduce((sum, s) => sum + s.critical, 0),
        warning: shows.reduce((sum, s) => sum + s.warning, 0),
        info: shows.reduce((sum, s) => sum + s.info, 0),
      },
      filters: {
        flag_type: flagType,
        severity,
        quarter,
        unresolved: unresolvedOnly,
        show,
      },
    })
  } catch (err) {
    console.error('GET /api/compliance/report failed:', err)
    return NextResponse.json({ error: 'Failed to generate compliance report' }, { status: 500 })
  }
}
