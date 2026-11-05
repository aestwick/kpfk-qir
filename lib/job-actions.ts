/**
 * Who may run which POST /api/jobs action — pure, so it can be unit-tested.
 *
 * Pipeline pause is layered (see CLAUDE.md "Pipeline pause is layered"): a
 * GLOBAL flag in qir_settings stops every station, and each station has its
 * own flag in station_settings. /api/jobs is a station page's API, so:
 *
 *   - pause/resume from a station page only touches THAT station   → editor
 *   - the global kill switch (every station) and the concurrency mode
 *     (shared worker pool) are platform-wide                       → super
 *   - retry/clear failed jobs are filtered to the active station's
 *     jobs (by job.data.stationId)                                  → editor
 *   - everything else enqueues work for the active station only     → editor
 *
 * Unknown actions resolve to 'editor' here and are rejected as 400 by the
 * route's own switch, so the role table never has to enumerate them.
 */

export type JobActionAccess = 'editor' | 'super'

export const JOB_ACTION_ACCESS: Record<string, JobActionAccess> = {
  // Per-station pause (station_settings) — the default for a station editor.
  pause_pipeline: 'editor',
  resume_pipeline: 'editor',
  // Global kill switch (qir_settings) — every station.
  pause_all: 'super',
  resume_all: 'super',
  // Shared worker-pool concurrency — every station.
  set_pipeline_mode: 'super',
  // Scoped to the active station's jobs.
  retry_failed: 'editor',
  clear_failed: 'editor',
  'advance-pipeline': 'editor',
  ingest: 'editor',
  transcribe: 'editor',
  summarize: 'editor',
  compliance: 'editor',
  'discover-sync': 'editor',
  'backfill-categories': 'editor',
}

export function jobActionAccess(action: unknown): JobActionAccess {
  if (typeof action !== 'string') return 'editor'
  return JOB_ACTION_ACCESS[action] ?? 'editor'
}

/**
 * Plain-English pause state for a station page. `global` is the platform-wide
 * kill switch; `station` is this station's own flag. Either one stops work.
 */
export interface PauseState {
  global: boolean
  station: boolean
}

export function describePause(state: PauseState): { paused: boolean; headline: string; detail: string } {
  if (state.global) {
    return {
      paused: true,
      headline: 'All stations are paused',
      detail: state.station
        ? 'A super-admin paused every station. This station is also paused on its own, so it stays paused after the all-stations pause is lifted.'
        : 'A super-admin paused every station. Only a super-admin can resume.',
    }
  }
  if (state.station) {
    return {
      paused: true,
      headline: 'This station is paused',
      detail: 'No processing will run for this station until it is resumed. Other stations are unaffected.',
    }
  }
  return { paused: false, headline: 'Running', detail: '' }
}
