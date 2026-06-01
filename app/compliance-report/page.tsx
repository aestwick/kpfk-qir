import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import PrintButton from './print-button'
import type { Metadata } from 'next'
import { ACTIVE_REVIEW_STATUSES, REVIEW_STATUSES, flagTypeLabel, type ReviewStatus } from '@/lib/compliance-status'
import ReportClient, { type ReportShow } from './report-client'

export const dynamic = 'force-dynamic'

async function resolveStation(slug: string): Promise<{ id: string; name: string } | null> {
  if (!slug) return null
  const { data } = await supabaseAdmin
    .from('stations')
    .select('id, name')
    .eq('slug', slug)
    .maybeSingle()
  return data ?? null
}

function getQuarterLabel(quarter: string): string {
  const [y, q] = quarter.split('-')
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const qNum = parseInt(q)
  const yNum = parseInt(y)
  const startMonth = (qNum - 1) * 3
  const endDate = new Date(yNum, startMonth + 3, 0)
  return `${months[startMonth]} 1, ${yNum} – ${months[startMonth + 2]} ${endDate.getDate()}, ${yNum}`
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}): Promise<Metadata> {
  const quarter = (searchParams.quarter as string) ?? ''
  const flagType = (searchParams.type as string) ?? ''
  const station = await resolveStation((searchParams.station as string) ?? '')
  const name = station?.name ?? 'Compliance Report'
  const title = `${name} Compliance Report${quarter ? ` — Q${quarter.split('-')[1]} ${quarter.split('-')[0]}` : ''}${flagType ? ` — ${flagTypeLabel(flagType)}` : ''}`
  return { title, description: title }
}

export default async function ComplianceReportPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const flagType = (searchParams.type as string) ?? ''
  const severity = (searchParams.severity as string) ?? ''
  const quarter = (searchParams.quarter as string) ?? ''
  // "unresolved=false" widens the *initial* server payload to every review
  // status; the default keeps it to active offenses only (investigating +
  // violation) so anonymous/print viewers never see raw AI suggestions. Signed-in
  // staff get the full set client-side (see report-client.tsx).
  const activeOnly = (searchParams.unresolved as string) !== 'false'
  const showFilter = (searchParams.show as string) ?? ''
  const stationSlug = (searchParams.station as string) ?? ''

  // Resolve the station this report is for (passed by the dashboard link).
  // No default — an unknown/missing station 404s rather than leaking cross-station.
  const station = await resolveStation(stationSlug)
  if (!station) {
    notFound()
  }

  const initialStatuses: ReviewStatus[] = activeOnly ? ACTIVE_REVIEW_STATUSES : [...REVIEW_STATUSES]

  // Build query — scoped to the station via the inner episode_log join
  // (compliance_flags has no station_id column of its own).
  let query = supabaseAdmin
    .from('compliance_flags')
    .select('*, episode_log!inner(show_name, show_key, air_date, air_start, duration, headline, host, mp3_url)')
    .eq('episode_log.station_id', station.id)
    .order('created_at', { ascending: false })

  if (flagType) query = query.eq('flag_type', flagType)
  if (severity) query = query.eq('severity', severity)
  query = query.in('review_status', initialStatuses)
  if (showFilter) query = query.ilike('episode_log.show_name', `%${showFilter}%`)

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

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <p className="text-red-600">Failed to load compliance data: {error.message}</p>
      </div>
    )
  }

  // Group by show > episode into the shape the client component consumes.
  const showMap = new Map<string, ReportShow>()
  for (const flag of flags ?? []) {
    const ep = flag.episode_log as any
    const key = ep.show_key as string

    if (!showMap.has(key)) {
      showMap.set(key, { show_name: ep.show_name ?? key, show_key: key, episodes: [], total_flags: 0, critical: 0, warning: 0, info: 0 })
    }
    const showGroup = showMap.get(key)!
    showGroup.total_flags++
    if (flag.severity === 'critical') showGroup.critical++
    else if (flag.severity === 'warning') showGroup.warning++
    else showGroup.info++

    let epGroup = showGroup.episodes.find((e) => e.episode_id === flag.episode_id)
    if (!epGroup) {
      epGroup = {
        episode_id: flag.episode_id,
        show_name: ep.show_name ?? key,
        show_key: key,
        air_date: ep.air_date,
        air_start: ep.air_start,
        duration: ep.duration,
        headline: ep.headline,
        host: ep.host,
        mp3_url: ep.mp3_url ?? null,
        flags: [],
      }
      showGroup.episodes.push(epGroup)
    }
    epGroup.flags.push({
      id: flag.id,
      flag_type: flag.flag_type,
      severity: flag.severity,
      excerpt: flag.excerpt,
      details: flag.details,
      timestamp_seconds: flag.timestamp_seconds,
      review_status: flag.review_status,
      resolved_by: flag.resolved_by,
      resolved_notes: flag.resolved_notes,
    })
  }

  const shows = Array.from(showMap.values())

  return (
    <>
      <style>{`
        @media print {
          body { margin: 0; padding: 0; background: white !important; color: black !important; font-size: 11px; }
          .report-container { max-width: 100%; padding: 0.4in; background: white !important; }
          .report-container * { color: inherit !important; background: transparent !important; }
          .no-print { display: none !important; }
          .report-entry { break-inside: avoid; }
          .report-show { break-inside: avoid-page; }
          .print-severity-critical { font-weight: bold; }
          .print-severity-warning { font-style: italic; }
          .severity-badge { border: 1px solid #999; padding: 1px 6px; border-radius: 3px; font-size: 9px; }
          @page { margin: 0.6in; }
        }
      `}</style>
      <div className="report-container max-w-5xl mx-auto px-6 py-8 bg-white dark:bg-surface text-warm-900 dark:text-warm-100">
        {/* Toolbar */}
        <div className="no-print mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <a
              href="/dashboard/compliance"
              className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            >
              &larr; Back to Compliance
            </a>
          </div>
          <PrintButton />
        </div>

        {/* Header */}
        <header className="text-center mb-8 border-b dark:border-warm-700 pb-6">
          <h1 className="text-2xl font-bold">{station.name} — Compliance Report</h1>
          {quarter && <p className="text-gray-600 dark:text-warm-400 mt-1">{getQuarterLabel(quarter)}</p>}
          <p className="text-xs text-gray-400 dark:text-warm-500 mt-2">
            Generated {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </header>

        <ReportClient
          stationSlug={stationSlug}
          quarter={quarter}
          initialShows={shows}
          initialFilters={{
            types: flagType ? [flagType] : [],
            severities: severity ? [severity] : [],
            statuses: initialStatuses,
            show: showFilter,
          }}
        />

        {/* Footer */}
        <footer className="text-center text-sm text-gray-500 dark:text-warm-400 border-t dark:border-warm-700 pt-4 mt-8">
          <p>{station.name} Compliance Report — Automated analysis, subject to review.</p>
        </footer>
      </div>
    </>
  )
}
