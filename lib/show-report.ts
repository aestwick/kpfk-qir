// Show report: what one show covered over a period — episodes, issue
// categories, guests, hosts. Pure rollup over episode rows (unit-tested in
// show-report.test.ts); the API route does the loading.

import { splitPeople, foldName } from './people'
import { timeToMinutes } from './broadcast-format'
import { SAME_AIRING_MINUTES } from './broadcast-day'

export interface ReportEpisodeRow {
  id: number
  show_key: string
  air_date: string | null
  air_start: string | null
  duration: number | null
  headline: string | null
  title: string | null
  summary: string | null
  host: string | null
  guest: string | null
  issue_category: string | null
  status: string
}

export interface Tally {
  name: string
  count: number
  episodeIds: number[]
}

export interface ShowReport {
  episodeCount: number
  totalMinutes: number
  /** Episodes not yet summarized (no topics yet) — said plainly in the UI. */
  pendingCount: number
  issues: Tally[]
  guests: Tally[]
  hosts: Tally[]
}

/** Issue categories that mean "not an FCC issue" and shouldn't headline a report. */
const NON_ISSUES = new Set(['skip', 'none', 'n/a', 'music'])

/** issue_category may hold one or several comma/semicolon-separated tags. */
export function splitIssues(v: string | null | undefined): string[] {
  if (!v) return []
  return v
    .split(/\s*[,;|]\s*/)
    .map((s) => s.trim())
    .filter((s) => s && !NON_ISSUES.has(s.toLowerCase()))
}

function tally(pairs: [string, number][]): Tally[] {
  const by = new Map<string, Tally>()
  for (const [name, id] of pairs) {
    const k = foldName(name)
    const t = by.get(k) ?? { name, count: 0, episodeIds: [] }
    if (!t.episodeIds.includes(id)) {
      t.episodeIds.push(id)
      t.count++
    }
    by.set(k, t)
  }
  return Array.from(by.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** One row per airing: sibling feeds of the show logged for the same airing
 *  (same date, start within a few minutes — the Broadcast Day folding rule)
 *  collapse to the first. Rows must be in air order. */
export function dedupeAirings<T extends Pick<ReportEpisodeRow, 'air_date' | 'air_start'>>(rows: T[]): T[] {
  const out: T[] = []
  for (const r of rows) {
    const start = timeToMinutes(r.air_start)
    const twin = out.find((o) => {
      const os = timeToMinutes(o.air_start)
      return o.air_date === r.air_date && os != null && start != null && Math.abs(os - start) <= SAME_AIRING_MINUTES
    })
    if (!twin) out.push(r)
  }
  return out
}

/** Roll up a show's episodes. Pass rows already de-duplicated (dedupeAirings). */
export function buildShowReport(rows: ReportEpisodeRow[]): ShowReport {
  const PUBLISHED = new Set(['summarized', 'compliance_checked'])
  return {
    episodeCount: rows.length,
    totalMinutes: rows.reduce((n, r) => n + (r.duration ?? 0), 0),
    pendingCount: rows.filter((r) => !PUBLISHED.has(r.status)).length,
    issues: tally(rows.flatMap((r) => splitIssues(r.issue_category).map((i): [string, number] => [i, r.id]))),
    guests: tally(rows.flatMap((r) => splitPeople(r.guest).map((g): [string, number] => [g, r.id]))),
    hosts: tally(rows.flatMap((r) => splitPeople(r.host).map((h): [string, number] => [h, r.id]))),
  }
}
