import type { EpisodeLog } from './types'

export interface QirEntry {
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

export function episodeToQirEntry(ep: EpisodeLog): QirEntry {
  return {
    episode_id: ep.id,
    show_name: ep.show_name ?? 'Unknown Show',
    host: ep.host ?? '',
    air_date: ep.date ?? ep.air_date ?? '',
    start_time: ep.start_time ?? '',
    duration: ep.duration ?? 0,
    headline: ep.headline ?? '',
    guest: ep.guest ?? '',
    summary: ep.summary ?? '',
    issue_category: ep.issue_category ?? 'Uncategorized',
  }
}

export function formatQirEntry(entry: QirEntry): string {
  const lines: string[] = []
  lines.push(`Program: ${entry.show_name}`)
  if (entry.host) lines.push(`Host: ${entry.host}`)
  lines.push(`Date: ${entry.air_date}`)
  lines.push(`Time: ${entry.start_time}`)
  lines.push(`Duration: ${entry.duration} minutes`)
  lines.push(`Topic: ${entry.headline}`)
  if (entry.guest) lines.push(`Guest(s): ${entry.guest}`)
  lines.push(`Description: ${entry.summary}`)
  return lines.join('\n')
}

export function getQuarterDateRange(year: number, quarter: number): { start: string; end: string; label: string } {
  const startMonth = (quarter - 1) * 3
  const start = new Date(year, startMonth, 1).toISOString().slice(0, 10)
  const end = new Date(year, startMonth + 3, 0).toISOString().slice(0, 10)

  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const startLabel = `${monthNames[startMonth]} 1, ${year}`
  const endDate = new Date(year, startMonth + 3, 0)
  const endLabel = `${monthNames[startMonth + 2]} ${endDate.getDate()}, ${year}`
  const label = `${startLabel} thru ${endLabel}`

  return { start, end, label }
}

export function formatFullReport(
  entries: QirEntry[],
  year: number,
  quarter: number
): string {
  const { label } = getQuarterDateRange(year, quarter)
  const header = `KPFK, Los Angeles - Quarterly Issues Report\n${label}\n`
  const separator = '='.repeat(60)

  const grouped = groupByCategory(entries)
  const sections: string[] = []

  for (const [category, catEntries] of Object.entries(grouped)) {
    const catSection = [`\n${separator}\nISSUE: ${category}\n${separator}`]
    for (const entry of catEntries) {
      catSection.push(`\n${formatQirEntry(entry)}`)
    }
    sections.push(catSection.join('\n'))
  }

  return header + sections.join('\n') + '\n\nNote: This list is by no means exhaustive.'
}

export function formatCuratedReport(
  entries: QirEntry[],
  year: number,
  quarter: number
): string {
  return formatFullReport(entries, year, quarter)
}

function groupByCategory(entries: QirEntry[]): Record<string, QirEntry[]> {
  const grouped: Record<string, QirEntry[]> = {}
  for (const entry of entries) {
    const cat = entry.issue_category || 'Uncategorized'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(entry)
  }
  return grouped
}
