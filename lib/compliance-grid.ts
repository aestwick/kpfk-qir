// Pure helpers for the Compliance Grid Report (no I/O).
//
// Geometry is borrowed from the CMS schedule builder (48 half-hour rows, Sunday-
// first week) but everything here is read-only aggregation, not editable slots.
// Kept side-effect free so both the API route and the render components — and a
// future unit test — can share it. See ideas/COMPLIANCE_GRID_REPORT_SPEC.md.

import type {
  GridAiring,
  GridColumn,
  Heatmap,
  MatrixRow,
} from './types'

// --- Grid geometry (borrowed: ROW_HEIGHT / TOTAL_ROWS / DAY_NAMES_SHORT) ------

export const ROW_HEIGHT = 28 // px per half-hour row
export const TOTAL_ROWS = 48 // 24h × 2 half-hour rows
export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// --- Date / time math (borrowed: timeToRow / dayOfWeekForIso / addDays / …) ---

/** `HH:MM:SS` (24h Pacific) → half-hour row 0..47. Clean at :00/:30 per spec. */
export function timeToRow(airStart: string | null): number | null {
  if (!airStart) return null
  const [h, m] = airStart.split(':').map((p) => parseInt(p, 10))
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  const row = h * 2 + Math.floor(m / 30)
  if (row < 0 || row >= TOTAL_ROWS) return null
  return row
}

/** Half-hour row → `HH:MM` 24h label. */
export function rowToTime(row: number): string {
  const h = Math.floor(row / 2)
  const m = row % 2 === 0 ? '00' : '30'
  return `${String(h).padStart(2, '0')}:${m}`
}

/** Half-hour row → 12-hour label, e.g. `6:00 AM`, `12:30 PM`. */
export function formatTime12(row: number): string {
  const h24 = Math.floor(row / 2)
  const m = row % 2 === 0 ? '00' : '30'
  const period = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${m} ${period}`
}

/** `YYYY-MM-DD` → day-of-week, 0=Sun … 6=Sat. Parsed as a UTC calendar date. */
export function dayOfWeekForIso(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

/** `YYYY-MM-DD` (+ n days) → `YYYY-MM-DD`, via UTC to avoid TZ drift. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Sunday-start week containing `iso`, as a `YYYY-MM-DD` date. */
export function weekStartFor(iso: string): string {
  return addDays(iso, -dayOfWeekForIso(iso))
}

/** Inclusive day span between two ISO dates. */
export function daysBetween(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime()
  const b = new Date(`${end}T00:00:00Z`).getTime()
  return Math.round((b - a) / 86_400_000) + 1
}

/** Weeks in a window, floored at 1. Presets (1/4/12/24wk) divide evenly. */
export function weeksInWindow(rangeDays: number): number {
  return Math.max(1, Math.round(rangeDays / 7))
}

/**
 * Every `YYYY-MM-DD` date in [start, end] (inclusive) falling on `dow` (0=Sun).
 * Lets a heatmap cell — which knows only a day-of-week + window — drill through
 * to a DB query via `air_date IN (...)`, keeping pagination on the DB side.
 */
export function datesForDowInWindow(start: string, end: string, dow: number): string[] {
  const dates: string[] = []
  // Jump straight to the first matching day, then step by 7.
  let cursor = addDays(start, (dow - dayOfWeekForIso(start) + 7) % 7)
  while (cursor <= end) {
    dates.push(cursor)
    cursor = addDays(cursor, 7)
  }
  return dates
}

// --- Aggregation --------------------------------------------------------------

/** Empty 7×48 half-hour grid. */
export function emptyHeatmap(): Heatmap {
  return Array.from({ length: 7 }, () => new Array(TOTAL_ROWS).fill(0))
}

/**
 * Bucket airings into the 7-day × 48-half-hour heatmap, summing offense counts.
 * Airings with no `air_start` (can't be placed in time) are skipped here; the
 * caller still counts them in totals/matrix. Returns half-hour resolution — the
 * client collapses to hourly for display, so the metric/granularity toggles need
 * no refetch.
 */
export function bucketEpisodes(airings: GridAiring[]): Heatmap {
  const grid = emptyHeatmap()
  for (const a of airings) {
    if (a.offenses <= 0) continue
    const day = dayOfWeekForIso(a.air_date)
    const row = timeToRow(a.air_start)
    if (row === null) continue
    grid[day][row] += a.offenses
  }
  return grid
}

/** Collapse a 7×48 half-hour grid to 7×24 hourly by summing each row pair. */
export function collapseToHourly(grid: Heatmap): Heatmap {
  return grid.map((day) => {
    const hours = new Array(24).fill(0)
    for (let r = 0; r < TOTAL_ROWS; r++) hours[Math.floor(r / 2)] += day[r]
    return hours
  })
}

/** Cell-by-cell B − A delta of two same-shaped grids. */
export function computeDelta(a: Heatmap, b: Heatmap): Heatmap {
  return a.map((row, d) => row.map((v, r) => (b[d]?.[r] ?? 0) - v))
}

/**
 * Build the show × period matrix columns for a window. Weekly columns up to 24
 * weeks, monthly beyond (the trend view for quarter-to-quarter reads).
 */
export function buildColumns(start: string, end: string): GridColumn[] {
  const rangeDays = daysBetween(start, end)
  const columns: GridColumn[] = []

  if (rangeDays <= 24 * 7) {
    // Weekly columns walked from the window start in 7-day steps.
    let cursor = start
    while (cursor <= end) {
      const colEnd = addDays(cursor, 6)
      const clampedEnd = colEnd > end ? end : colEnd
      columns.push({
        key: cursor,
        label: shortDate(cursor),
        start: cursor,
        end: clampedEnd,
        weeks: Math.max(1, daysBetween(cursor, clampedEnd) / 7),
      })
      cursor = addDays(colEnd, 1)
    }
    return columns
  }

  // Monthly columns walked across calendar months.
  let cursor = `${start.slice(0, 7)}-01`
  while (cursor <= end) {
    const monthStart = cursor < start ? start : cursor
    const lastOfMonth = endOfMonth(cursor)
    const monthEnd = lastOfMonth > end ? end : lastOfMonth
    columns.push({
      key: cursor.slice(0, 7),
      label: monthLabel(cursor),
      start: monthStart,
      end: monthEnd,
      weeks: Math.max(1, daysBetween(monthStart, monthEnd) / 7),
    })
    cursor = addDays(lastOfMonth, 1)
  }
  return columns
}

/** Group airings into matrix rows (show × period), sorted by total desc. */
export function buildMatrix(airings: GridAiring[], columns: GridColumn[]): MatrixRow[] {
  const byShow = new Map<string, MatrixRow>()
  for (const a of airings) {
    if (a.offenses <= 0) continue
    let row = byShow.get(a.show_key)
    if (!row) {
      row = {
        show_key: a.show_key,
        show_name: a.show_name ?? a.show_key,
        total: 0,
        cells: new Array(columns.length).fill(0),
      }
      byShow.set(a.show_key, row)
    }
    const col = columns.findIndex((c) => a.air_date >= c.start && a.air_date <= c.end)
    if (col >= 0) row.cells[col] += a.offenses
    row.total += a.offenses
  }
  return Array.from(byShow.values()).sort((x, y) => y.total - x.total)
}

// --- Color scale --------------------------------------------------------------

// Single-hue kpfk.red intensity ramp keyed to bucketed offense density. Empty
// cells stay neutral. Intensity encodes density, not genre (unlike the CMS).
const INTENSITY_BUCKETS: { max: number; cls: string }[] = [
  { max: 0, cls: 'bg-warm-100 dark:bg-warm-800' },
  { max: 1, cls: 'bg-kpfk-red/20 text-kpfk-red-dark dark:text-warm-100' },
  { max: 3, cls: 'bg-kpfk-red/40 text-kpfk-red-dark dark:text-warm-100' },
  { max: 6, cls: 'bg-kpfk-red/65 text-white' },
  { max: Infinity, cls: 'bg-kpfk-red text-white' },
]

/** Tailwind classes for a heatmap/matrix cell given its offense value. */
export function intensityClass(value: number): string {
  for (const b of INTENSITY_BUCKETS) {
    if (value <= b.max) return b.cls
  }
  return INTENSITY_BUCKETS[INTENSITY_BUCKETS.length - 1].cls
}

// Diverging green↔red scale for the delta view, centered at 0 (green = fewer
// offenses in B, red = more).
export function deltaClass(value: number): string {
  if (value === 0) return 'bg-warm-100 dark:bg-warm-800 text-warm-400'
  if (value <= -4) return 'bg-green-600 text-white'
  if (value <= -1) return 'bg-green-500/40 text-green-800 dark:text-green-200'
  if (value >= 4) return 'bg-kpfk-red text-white'
  return 'bg-kpfk-red/40 text-kpfk-red-dark dark:text-warm-100'
}

// --- Small date label helpers -------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function shortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

function monthLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`
}

function endOfMonth(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return last.toISOString().slice(0, 10)
}
