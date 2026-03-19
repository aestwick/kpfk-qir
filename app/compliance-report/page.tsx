import { supabaseAdmin } from '@/lib/supabase'
import PrintButton from './print-button'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

interface ComplianceFlag {
  id: number
  flag_type: string
  severity: string
  excerpt: string | null
  details: string | null
  timestamp_seconds: number | null
  resolved: boolean
  resolved_by: string | null
  resolved_notes: string | null
}

interface EpisodeGroup {
  episode_id: number
  show_name: string
  air_date: string | null
  air_time: string | null
  duration: number | null
  headline: string | null
  host: string | null
  flags: ComplianceFlag[]
}

interface ShowGroup {
  show_name: string
  show_key: string
  episodes: EpisodeGroup[]
  total_flags: number
  critical: number
  warning: number
  info: number
}

const typeLabels: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Station ID Missing',
  technical: 'Technical Issue',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID Missing',
  indecency: 'Indecency',
}

const severityColors: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800/40',
  warning: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800/40',
  info: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800/40',
}

const severityPrintColors: Record<string, string> = {
  critical: 'print-severity-critical',
  warning: 'print-severity-warning',
  info: 'print-severity-info',
}

function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
  return `${m}:${s.toString().padStart(2, '0')}`
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
  const title = `KPFK Compliance Report${quarter ? ` — Q${quarter.split('-')[1]} ${quarter.split('-')[0]}` : ''}${flagType ? ` — ${typeLabels[flagType] ?? flagType}` : ''}`
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
  const unresolvedOnly = (searchParams.unresolved as string) !== 'false' // default true
  const showFilter = (searchParams.show as string) ?? ''

  // Build query
  let query = supabaseAdmin
    .from('compliance_flags')
    .select('*, episode_log!inner(show_name, show_key, air_date, air_time, duration, headline, host)')
    .order('created_at', { ascending: false })

  if (flagType) query = query.eq('flag_type', flagType)
  if (severity) query = query.eq('severity', severity)
  if (unresolvedOnly) query = query.eq('resolved', false)
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

  // Group by show > episode, sort by severity
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 }
  const showMap = new Map<string, ShowGroup>()

  for (const flag of flags ?? []) {
    const ep = flag.episode_log as any
    const key = ep.show_key as string

    if (!showMap.has(key)) {
      showMap.set(key, {
        show_name: ep.show_name ?? key,
        show_key: key,
        episodes: [],
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

    let epGroup = showGroup.episodes.find((e) => e.episode_id === flag.episode_id)
    if (!epGroup) {
      epGroup = {
        episode_id: flag.episode_id,
        show_name: ep.show_name ?? key,
        air_date: ep.air_date,
        air_time: ep.air_time,
        duration: ep.duration,
        headline: ep.headline,
        host: ep.host,
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
      resolved: flag.resolved,
      resolved_by: flag.resolved_by,
      resolved_notes: flag.resolved_notes,
    })
  }

  // Sort flags by severity within each episode, episodes by date, shows by critical count
  const shows = Array.from(showMap.values())
    .map((s) => ({
      ...s,
      episodes: s.episodes.map((ep) => ({
        ...ep,
        flags: ep.flags.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3)),
      })).sort((a, b) => (a.air_date ?? '').localeCompare(b.air_date ?? '')),
    }))
    .sort((a, b) => a.critical !== b.critical ? b.critical - a.critical : b.total_flags - a.total_flags)

  const totalFlags = shows.reduce((sum, s) => sum + s.total_flags, 0)
  const totalCritical = shows.reduce((sum, s) => sum + s.critical, 0)
  const totalWarning = shows.reduce((sum, s) => sum + s.warning, 0)
  const totalInfo = shows.reduce((sum, s) => sum + s.info, 0)
  const totalEpisodes = shows.reduce((sum, s) => sum + s.episodes.length, 0)

  // Build active filters description
  const filterParts: string[] = []
  if (flagType) filterParts.push(typeLabels[flagType] ?? flagType)
  if (severity) filterParts.push(`${severity} only`)
  if (unresolvedOnly) filterParts.push('unresolved only')
  if (showFilter) filterParts.push(`show: "${showFilter}"`)

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
          <h1 className="text-2xl font-bold">KPFK 90.7 FM — Compliance Report</h1>
          {quarter && (
            <p className="text-gray-600 dark:text-warm-400 mt-1">{getQuarterLabel(quarter)}</p>
          )}
          {filterParts.length > 0 && (
            <p className="text-sm text-gray-500 dark:text-warm-500 mt-1">
              Filters: {filterParts.join(' | ')}
            </p>
          )}
          <p className="text-xs text-gray-400 dark:text-warm-500 mt-2">
            Generated {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
          </p>
        </header>

        {/* Summary */}
        <section className="mb-8 border dark:border-warm-700 rounded-lg overflow-hidden">
          <div className="bg-gray-50 dark:bg-warm-800 px-5 py-3 border-b dark:border-warm-700">
            <h2 className="text-sm font-bold uppercase tracking-wide text-gray-600 dark:text-warm-400">Summary</h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 divide-x dark:divide-warm-700">
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold">{totalFlags}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Total Flags</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold">{shows.length}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Shows</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold">{totalEpisodes}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Episodes</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{totalCritical}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Critical</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{totalWarning}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Warning</p>
            </div>
            <div className="px-4 py-3 text-center">
              <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{totalInfo}</p>
              <p className="text-xs text-gray-500 dark:text-warm-400">Info</p>
            </div>
          </div>
        </section>

        {/* No results */}
        {shows.length === 0 && (
          <div className="text-center py-16 text-gray-400 dark:text-warm-500">
            <p className="text-lg">No compliance flags found matching these filters.</p>
          </div>
        )}

        {/* Shows */}
        {shows.map((show) => (
          <section key={show.show_key} className="report-show mb-8">
            <div className="flex items-baseline justify-between border-b-2 border-gray-800 dark:border-warm-400 pb-1 mb-4">
              <h3 className="text-lg font-bold uppercase">{show.show_name}</h3>
              <span className="text-xs text-gray-500 dark:text-warm-500">
                {show.total_flags} flag{show.total_flags !== 1 ? 's' : ''}
                {show.critical > 0 && <span className="text-red-600 dark:text-red-400 ml-2">{show.critical} critical</span>}
                {show.warning > 0 && <span className="text-amber-600 dark:text-amber-400 ml-2">{show.warning} warning</span>}
              </span>
            </div>

            {show.episodes.map((ep) => (
              <div key={ep.episode_id} className="report-entry mb-5 ml-2">
                {/* Episode header */}
                <div className="mb-2">
                  <p className="font-semibold text-sm">
                    {ep.air_date ?? 'Unknown date'}
                    {ep.air_time && <span className="text-gray-500 dark:text-warm-400"> at {ep.air_time}</span>}
                    {ep.duration && <span className="text-gray-500 dark:text-warm-400"> ({ep.duration} min)</span>}
                  </p>
                  {ep.headline && (
                    <p className="text-sm text-gray-600 dark:text-warm-400">{ep.headline}</p>
                  )}
                  {ep.host && (
                    <p className="text-xs text-gray-500 dark:text-warm-500">Host: {ep.host}</p>
                  )}
                </div>

                {/* Flags table */}
                <div className="border dark:border-warm-700 rounded-lg overflow-hidden ml-2">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 dark:bg-warm-800">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-24">Severity</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-32">Type</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase w-16">Time</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase">Excerpt / Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-warm-700">
                      {ep.flags.map((flag) => (
                        <tr key={flag.id} className={`${severityPrintColors[flag.severity] ?? ''}`}>
                          <td className="px-3 py-2">
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium severity-badge ${severityColors[flag.severity] ?? ''}`}>
                              {flag.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-gray-700 dark:text-warm-300">
                            {typeLabels[flag.flag_type] ?? flag.flag_type}
                          </td>
                          <td className="px-3 py-2 text-xs font-mono text-gray-500 dark:text-warm-400">
                            {flag.timestamp_seconds != null ? formatTimestamp(flag.timestamp_seconds) : '--'}
                          </td>
                          <td className="px-3 py-2">
                            {flag.excerpt && (
                              <p className="text-sm text-gray-800 dark:text-warm-200">
                                &ldquo;{flag.excerpt}&rdquo;
                              </p>
                            )}
                            {flag.details && (
                              <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5">{flag.details}</p>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        ))}

        {/* Footer */}
        <footer className="text-center text-sm text-gray-500 dark:text-warm-400 border-t dark:border-warm-700 pt-4 mt-8">
          <p>KPFK 90.7 FM Compliance Report — Automated analysis, subject to review.</p>
        </footer>
      </div>
    </>
  )
}
