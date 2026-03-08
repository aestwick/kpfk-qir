import { supabaseAdmin } from '@/lib/supabase'
import { notFound } from 'next/navigation'
import PrintButton from './print-button'
import type { Metadata } from 'next'

// Revalidate finalized reports once per day — they rarely change
export const revalidate = 86400

export async function generateMetadata({
  params,
}: {
  params: { year: string; quarter: string }
}): Promise<Metadata> {
  const year = parseInt(params.year)
  const quarter = parseInt(params.quarter)
  const title = `KPFK Quarterly Issues Report — Q${quarter} ${year}`
  const description = `KPFK, Los Angeles — FCC Quarterly Issues Report for Q${quarter} ${year}`
  return { title, description }
}

interface QirEntry {
  episode_id: number
  show_name: string
  host: string
  air_date: string
  start_time: string
  duration: number
  headline: string
  guest: string
  summary: string
  issue_category: string
}

function getQuarterLabel(year: number, quarter: number): string {
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  const startMonth = (quarter - 1) * 3
  const endDate = new Date(year, startMonth + 3, 0)
  return `${months[startMonth]} 1, ${year} thru ${months[startMonth + 2]} ${endDate.getDate()}, ${year}`
}

function groupByCategory(entries: QirEntry[]): Record<string, QirEntry[]> {
  const grouped: Record<string, QirEntry[]> = {}
  for (const e of entries) {
    const cat = e.issue_category || 'Uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(e)
  }
  return grouped
}

export default async function PublicQirPage({
  params,
}: {
  params: { year: string; quarter: string }
}) {
  const year = parseInt(params.year)
  const quarter = parseInt(params.quarter)

  if (isNaN(year) || isNaN(quarter) || quarter < 1 || quarter > 4) {
    notFound()
  }

  const { data: draft } = await supabaseAdmin
    .from('qir_drafts')
    .select('*')
    .eq('year', year)
    .eq('quarter', quarter)
    .eq('status', 'final')
    .order('version', { ascending: false })
    .limit(1)
    .single()

  if (!draft) {
    notFound()
  }

  const entries = (draft.curated_entries ?? []) as QirEntry[]
  const grouped = groupByCategory(entries)
  const label = getQuarterLabel(year, quarter)

  return (
    <>
      <style>{`
        @media print {
          body { margin: 0; padding: 0; background: white !important; color: black !important; }
          .qir-container { max-width: 100%; padding: 0.5in; background: white !important; }
          .qir-container * { color: inherit !important; background: transparent !important; border-color: #ccc !important; }
          .no-print { display: none !important; }
          .qir-entry { break-inside: avoid; }
          @page { margin: 0.75in; }
        }
      `}</style>
      <div className="qir-container max-w-4xl mx-auto px-6 py-8 bg-white dark:bg-surface text-warm-900 dark:text-warm-100">
        <div className="no-print mb-4">
          <PrintButton />
        </div>

        <header className="text-center mb-8 border-b dark:border-warm-700 pb-6">
          <h1 className="text-2xl font-bold">
            KPFK, Los Angeles
          </h1>
          <h2 className="text-lg text-gray-600 dark:text-warm-400 mt-1">
            Quarterly Issues Report
          </h2>
          <p className="text-gray-500 dark:text-warm-400 mt-1">{label}</p>
        </header>

        {Object.entries(grouped).map(([category, catEntries]) => (
          <section key={category} className="mb-8">
            <h3 className="text-lg font-bold border-b-2 border-gray-800 dark:border-warm-400 pb-1 mb-4 uppercase">
              {category}
            </h3>
            <div className="space-y-5">
              {catEntries.map((entry) => (
                <div key={entry.episode_id} className="qir-entry">
                  <p className="font-semibold">
                    {entry.show_name}
                    {entry.host && (
                      <span className="font-normal text-gray-600 dark:text-warm-400">
                        {' '}— hosted by {entry.host}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-gray-600 dark:text-warm-400">
                    {entry.air_date} | {entry.start_time} | {entry.duration}{' '}
                    minutes
                  </p>
                  <p className="text-sm font-medium mt-1">{entry.headline}</p>
                  {entry.guest && (
                    <p className="text-sm text-gray-600 dark:text-warm-400">
                      Guest(s): {entry.guest}
                    </p>
                  )}
                  <p className="text-sm mt-1">{entry.summary}</p>
                </div>
              ))}
            </div>
          </section>
        ))}

        <footer className="text-center text-sm text-gray-500 dark:text-warm-400 border-t dark:border-warm-700 pt-4 mt-8">
          <p>Note: This list is by no means exhaustive.</p>
        </footer>
      </div>
    </>
  )
}
