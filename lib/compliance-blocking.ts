import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Compliance blocking — the ONE definition of which flags hold an episode out
 * of the QIR draft, shared by the generate worker (which enforces it) and the
 * report page (which shows it), so the two can never disagree.
 *
 * Rule (unchanged): when `compliance_blocking` is on, an episode with ANY
 * critical flag whose review_status is not 'dismissed' is held out. That
 * includes 'suggested' — flags nobody has reviewed yet — not just the
 * 'investigating' / 'violation' set the compliance dashboards call "active".
 * Warnings never block.
 */

export const BLOCKING_SEVERITY = 'critical'
export const CLEARING_REVIEW_STATUS = 'dismissed'

export interface BlockingFlagRow {
  episode_id: number
  severity: string
  review_status: string
}

/** True if this one flag holds its episode out of the draft. */
export function isBlockingFlag(flag: Pick<BlockingFlagRow, 'severity' | 'review_status'>): boolean {
  return flag.severity === BLOCKING_SEVERITY && flag.review_status !== CLEARING_REVIEW_STATUS
}

export interface BlockedEpisodeSummary {
  episode_id: number
  /** Blocking (critical, not dismissed) flags on this episode. */
  blocking_flags: number
  /** Of those, how many nobody has reviewed yet ('suggested'). */
  unreviewed: number
}

/**
 * Collapse flag rows into one summary per blocked episode (sorted by id).
 * Non-blocking rows are ignored, so callers may pass a broader result set.
 */
export function summarizeBlockedEpisodes(flags: BlockingFlagRow[]): BlockedEpisodeSummary[] {
  const byEpisode = new Map<number, BlockedEpisodeSummary>()
  for (const f of flags) {
    if (!isBlockingFlag(f)) continue
    const row = byEpisode.get(f.episode_id) ?? { episode_id: f.episode_id, blocking_flags: 0, unreviewed: 0 }
    row.blocking_flags++
    if (f.review_status === 'suggested') row.unreviewed++
    byEpisode.set(f.episode_id, row)
  }
  return Array.from(byEpisode.values()).sort((a, b) => a.episode_id - b.episode_id)
}

/**
 * Fetch the blocking flags for a set of candidate episodes. Chunked: ~2000 ids
 * in one `in.(…)` overflows the request URL. The query mirrors
 * isBlockingFlag() exactly (severity = critical AND review_status <> dismissed;
 * review_status is NOT NULL, migration 025).
 */
export async function fetchBlockingFlags(
  client: SupabaseClient,
  episodeIds: number[],
): Promise<BlockingFlagRow[]> {
  const rows: BlockingFlagRow[] = []
  for (let i = 0; i < episodeIds.length; i += 200) {
    const { data, error } = await client
      .from('compliance_flags')
      .select('episode_id, severity, review_status')
      .in('episode_id', episodeIds.slice(i, i + 200))
      .eq('severity', BLOCKING_SEVERITY)
      .neq('review_status', CLEARING_REVIEW_STATUS)
    if (error) throw new Error(`Failed to fetch compliance flags: ${error.message}`)
    rows.push(...((data ?? []) as BlockingFlagRow[]))
  }
  return rows
}

/** What GET /api/qir/blocking returns (minus per-episode detail). */
export interface BlockingStatus {
  blocking_enabled: boolean
  blocked: { episode_id: number }[]
  blocking_flags: number
  unreviewed_flags: number
}

export interface ComplianceCheckResult {
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The report page's "Compliance" pre-finalization check.
 *
 * Blocking ON  → count exactly what the worker holds out (critical, not
 *   dismissed — unreviewed included). Held-out episodes aren't in the draft,
 *   so it's a warning to review, not a hard fail.
 * Blocking OFF → nothing is held out, so undismissed critical flags on this
 *   quarter's candidates may be IN the draft. That's surfaced as a warning
 *   (not a new hard fail — finalize policy is unchanged); confirmed active
 *   critical flags (investigating/violation) still fail, as before.
 *
 * `active` is the legacy station-wide summary; `blocking` is null until the
 * blocking status has loaded (then the check reports "checking…").
 */
export function complianceValidation(
  blocking: BlockingStatus | null,
  active: { total: number; critical: number },
): ComplianceCheckResult {
  if (!blocking) return { status: 'warn', detail: 'Checking compliance flags…' }
  const held = blocking.blocked.length
  const flagsDetail = `${plural(blocking.blocking_flags, 'critical flag')} not dismissed, ${blocking.unreviewed_flags} never reviewed`

  if (blocking.blocking_enabled) {
    if (held === 0) {
      return { status: 'pass', detail: 'Compliance blocking is on — no episodes held out of this draft' }
    }
    return {
      status: 'warn',
      detail: `Compliance blocking is on — ${plural(held, 'episode')} held out of this draft (${flagsDetail}). Review the flags to include them.`,
    }
  }

  if (active.critical > 0) {
    return { status: 'fail', detail: `Compliance blocking is off — ${plural(active.critical, 'critical compliance flag')} active` }
  }
  if (held > 0) {
    return {
      status: 'warn',
      detail: `Compliance blocking is off — ${plural(held, 'episode')} with undismissed critical flags may be in this draft (${flagsDetail}).`,
    }
  }
  if (active.total > 0) {
    return { status: 'warn', detail: `Compliance blocking is off — ${plural(active.total, 'active compliance warning')}` }
  }
  return { status: 'pass', detail: 'Compliance blocking is off — no active compliance flags' }
}
