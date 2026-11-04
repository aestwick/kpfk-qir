// What a stage worker's follow-up job (continue / backoff) must carry forward
// from the job that just finished. Shared by the transcribe, summarize and
// compliance completion handlers in workers/index.ts so they can't drift.
//
// - stationId: tenancy (always).
// - window:    a historical backfill's explicit date window — without it the
//              drain snaps back to the current quarter and strands the backfill.
// - source/chain: the "auto-chain to the next stage" flags. The zero-progress
//              backoff used to drop these, so one batch of 404s silently ended
//              a backfill's transcribe→summarize→compliance cascade.
//
// Deliberately NOT carried: show_key. A show-scoped compliance run re-selects
// already-checked rows, so continuing it show-scoped would re-check the same
// first batch forever; the continuation falls back to a station-wide sweep.
export interface StageJobData {
  stationId?: string
  window?: { start?: string; end?: string }
  source?: string
  chain?: boolean
  [key: string]: unknown
}

export function continuationData(data: StageJobData | undefined | null): StageJobData {
  return {
    stationId: data?.stationId,
    ...(data?.window ? { window: data.window } : {}),
    ...(data?.chain ? { source: data.source, chain: true } : {}),
  }
}

/** Delay before retrying a stage that made zero progress but still has work. */
export const ZERO_PROGRESS_BACKOFF_MS = 5 * 60 * 1000
