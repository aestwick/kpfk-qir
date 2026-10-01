// Shared quarter helpers. Single source of truth so dropdowns stay consistent
// and never offer a quarter that hasn't happened yet (e.g. Q4 2026 on June 1).

export interface QuarterOption {
  /** Human label, e.g. "Q1 2025". */
  label: string
  year: number
  /** 1–4. */
  quarter: number
}

/** Current calendar quarter (1–4) and year for `now` (defaults to today). */
export function getCurrentQuarter(now: Date = new Date()): { year: number; quarter: number } {
  return { year: now.getFullYear(), quarter: Math.floor(now.getMonth() / 3) + 1 }
}

/**
 * The current quarter's date window — THE definition of the pipeline's
 * current-quarter gate. The transcribe/summarize/compliance candidate queries
 * pin to exactly these bounds (server-local clock, like every worker), so any
 * code reasoning about the gate (e.g. verify-week's "stuck pending" diagnosis)
 * must use this helper rather than re-deriving the quarter in another timezone.
 */
export function getCurrentQuarterBounds(now: Date = new Date()): { start: string; end: string } {
  const year = now.getFullYear()
  const quarter = Math.floor(now.getMonth() / 3)
  const startMonth = quarter * 3
  const start = new Date(year, startMonth, 1).toISOString().split('T')[0]
  const end = new Date(year, startMonth + 3, 0).toISOString().split('T')[0]
  return { start, end }
}

/**
 * How many days into a new quarter the pipeline keeps processing the PREVIOUS
 * quarter's episodes. Why: the FCC QIR for a quarter is due ~the 10th of the
 * following month, and the quarter flips at 00:00 UTC (5 PM Pacific on the last
 * day) — so late-evening last-day airings ingested after the flip, plus
 * backfills and retries, would otherwise be stranded `pending` forever behind
 * the current-quarter gate (seen at Q2→Q3 and Q3→Q4 2026).
 */
export const QUARTER_GRACE_DAYS = 10

/**
 * The window the transcribe/summarize/compliance workers fall back to when a
 * job carries no explicit `window`. Same bounds as getCurrentQuarterBounds()
 * (same server clock), except that during the first QUARTER_GRACE_DAYS days of a
 * quarter the start reaches back to the previous quarter's start, so that
 * quarter's stragglers finish before the filing deadline. Display surfaces
 * (dashboards, backlog counts) keep the strict current-quarter definition.
 */
export function getProcessingWindowBounds(now: Date = new Date()): { start: string; end: string } {
  const { start, end } = getCurrentQuarterBounds(now)
  const startMonth = Math.floor(now.getMonth() / 3) * 3
  // Whole days elapsed since the quarter began (day 1 = 0). Compared via UTC
  // of the local calendar fields so DST shifts can't skew the count.
  const daysIntoQuarter =
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(now.getFullYear(), startMonth, 1)) /
    86_400_000
  if (daysIntoQuarter >= QUARTER_GRACE_DAYS) return { start, end }
  // Month -3 rolls into the previous year automatically (Q1 → prior Q4).
  const previous = getCurrentQuarterBounds(new Date(now.getFullYear(), startMonth - 3, 1))
  return { start: previous.start, end }
}

/**
 * Quarter options from the current quarter backwards, newest first.
 * Never includes future quarters.
 *
 * @param yearsBack how many full prior years of history to include (default 2)
 */
export function getQuarterOptions(yearsBack = 2, now: Date = new Date()): QuarterOption[] {
  const { year: currentYear, quarter: currentQuarter } = getCurrentQuarter(now)
  const options: QuarterOption[] = []
  for (let y = currentYear; y >= currentYear - yearsBack; y--) {
    // The current year only runs up to the current quarter; prior years are full.
    const maxQ = y === currentYear ? currentQuarter : 4
    for (let q = maxQ; q >= 1; q--) {
      options.push({ label: `Q${q} ${y}`, year: y, quarter: q })
    }
  }
  return options
}
