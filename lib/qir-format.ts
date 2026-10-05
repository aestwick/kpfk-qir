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
  quarter: number,
  stationName: string
): string {
  const { label } = getQuarterDateRange(year, quarter)
  const header = `${stationName} - Quarterly Issues Report\n${label}\n`
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
  quarter: number,
  stationName: string
): string {
  return formatFullReport(entries, year, quarter, stationName)
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

const MONTH_INDEX: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

/**
 * Parse a QIR entry date to UTC midnight. Entries carry either the ISO
 * `air_date` ("2026-07-17") or the long display `date` from ingest
 * ("Friday, July 17, 2026") — `episodeToQirEntry` prefers the latter. Parsed
 * explicitly rather than via `new Date(str)`, whose handling of the long form
 * varies by browser. Returns null when unparseable.
 */
export function parseEntryDate(s: string | null | undefined): Date | null {
  if (!s) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]))
  const long = /([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(s)
  if (long) {
    const month = MONTH_INDEX[long[1].toLowerCase()]
    if (month !== undefined) return new Date(Date.UTC(+long[3], month, +long[2]))
  }
  return null
}

/**
 * First-to-last span (days) and distinct calendar months across entry dates.
 * Null when fewer than two dates parse. Dates must be compared as dates — a
 * string sort of the long display form orders them by weekday name.
 */
export function summarizeDateSpread(
  dates: Array<string | null | undefined>
): { spanDays: number; months: number } | null {
  const parsed = dates.map(parseEntryDate).filter((d): d is Date => d !== null)
  if (parsed.length < 2) return null
  const times = parsed.map((d) => d.getTime())
  const spanDays = Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000)
  const months = new Set(parsed.map((d) => d.toISOString().slice(0, 7))).size
  return { spanDays, months }
}

/**
 * Pick at most `cap` curation candidates from one category, spread evenly
 * across the quarter: bucket by week, rank each week by `score` (stable, so
 * ties keep input order), then round-robin across weeks. The result is
 * interleaved in time, so a long prompt doesn't present the model with all of
 * the first month before anything later. Entries without a parseable date
 * share one trailing bucket.
 */
export function spreadCandidates<T>(
  entries: T[],
  cap: number,
  getDate: (e: T) => string | null | undefined,
  score: (e: T) => number
): T[] {
  if (entries.length <= cap) return entries
  const buckets = new Map<number, T[]>()
  for (const e of entries) {
    const d = parseEntryDate(getDate(e))
    const week = d ? Math.floor(d.getTime() / (7 * 86_400_000)) : Number.MAX_SAFE_INTEGER
    const list = buckets.get(week) ?? []
    list.push(e)
    buckets.set(week, list)
  }
  const ordered = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) =>
      list
        .map((e, i) => ({ e, i, s: score(e) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.e)
    )
  const picked: T[] = []
  for (let round = 0; picked.length < cap; round++) {
    let any = false
    for (const list of ordered) {
      if (round < list.length) {
        picked.push(list[round])
        any = true
        if (picked.length >= cap) break
      }
    }
    if (!any) break
  }
  return picked
}
