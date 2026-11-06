import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import PrintButton from './print-button'
import type { Metadata } from 'next'
import { ACTIVE_REVIEW_STATUSES, REVIEW_STATUSES, flagTypeLabel, type ReviewStatus } from '@/lib/compliance-status'
import ReportClient from './report-client'

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

export async function generateMetadata(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }
): Promise<Metadata> {
  const searchParams = await props.searchParams;
  const quarter = (searchParams.quarter as string) ?? ''
  const flagType = (searchParams.type as string) ?? ''
  const station = await resolveStation((searchParams.station as string) ?? '')
  const name = station?.name ?? 'Compliance Report'
  const title = `${name} Compliance Report${quarter ? ` — Q${quarter.split('-')[1]} ${quarter.split('-')[0]}` : ''}${flagType ? ` — ${flagTypeLabel(flagType)}` : ''}`
  return { title, description: title }
}

export default async function ComplianceReportPage(
  props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }
) {
  const searchParams = await props.searchParams;
  const flagType = (searchParams.type as string) ?? ''
  const severity = (searchParams.severity as string) ?? ''
  const quarter = (searchParams.quarter as string) ?? ''
  // "unresolved=false" pre-selects every review status in the filter chips;
  // the default pre-selects active offenses only (investigating + violation).
  const activeOnly = (searchParams.unresolved as string) !== 'false'
  const showFilter = (searchParams.show as string) ?? ''
  const stationSlug = (searchParams.station as string) ?? ''

  // Resolve the station this report is for (passed by the dashboard link).
  // No default — an unknown/missing station 404s rather than leaking cross-station.
  const station = await resolveStation(stationSlug)
  if (!station) {
    notFound()
  }

  // Flags are NOT loaded here. This route used to read them with the
  // service-role key and render them for anyone holding the link (and
  // ?unresolved=false widened that to every flag, raw AI suggestions and
  // dismissals included). ReportClient now loads them through the
  // authenticated API, so RLS decides who sees what.
  const initialStatuses: ReviewStatus[] = activeOnly ? ACTIVE_REVIEW_STATUSES : [...REVIEW_STATUSES]

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
