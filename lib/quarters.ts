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
