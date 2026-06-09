// Compliance flag review workflow.
//
// Each flag the AI/wordlist raises starts life as a *suggestion*. A reviewer
// then triages it through the workflow:
//
//   suggested → investigating → violation   (yes, a real FCC violation)
//                            └→ dismissed    (no, the AI got it wrong)
//
// Only `investigating` + `violation` count as *active* compliance offenses —
// the numbers that drive the dashboard badges, the offense grid, per-show
// health, and the public report. Raw `suggested` AI noise and `dismissed`
// false-positives stay out of those counts, which is the whole point: the AI
// gets it wrong a lot, so untriaged suggestions shouldn't pollute the totals.

export const REVIEW_STATUSES = ['suggested', 'investigating', 'violation', 'dismissed'] as const

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]

// The statuses that count as active compliance offenses.
export const ACTIVE_REVIEW_STATUSES: ReviewStatus[] = ['investigating', 'violation']

export function isActiveReviewStatus(status: string | null | undefined): boolean {
  return status === 'investigating' || status === 'violation'
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value)
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  suggested: 'Suggested',
  investigating: 'Investigating',
  violation: 'Violation',
  dismissed: 'Dismissed',
}

// Human labels for the compliance check types raised by workers/compliance.ts.
export const FLAG_TYPE_LABELS: Record<string, string> = {
  profanity: 'Profanity',
  indecency: 'Indecency',
  obscenity: 'Obscenity',
  station_id_missing: 'Station ID Missing',
  technical: 'Technical Issue',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID Missing',
}

export function flagTypeLabel(type: string): string {
  return FLAG_TYPE_LABELS[type] ?? type
}

// Tailwind badge classes per status (light + dark).
export const REVIEW_STATUS_BADGE: Record<ReviewStatus, string> = {
  suggested: 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-300',
  investigating: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  violation: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  dismissed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
}
