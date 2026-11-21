// Transcription stall detector — pure, so it's testable and shared by the API.
//
// Why this exists: on 2026-11-18 a transcribe batch hung on a dead archive
// download and held the station's chain lock for three days. Ingest kept
// running, nothing was marked failed, and every later transcribe job was a
// silent "locked" skip — the dashboard looked healthy while 74 episodes piled
// up. The signal has to come from the database, not the worker, because the
// worker is the thing that's stuck: claimable work is waiting AND nothing has
// been transcribed for a while.

export const STALL_THRESHOLD_MS = 2 * 60 * 60_000 // 2 hours

export interface StallInputs {
  /** Effective pause (global OR station). A paused pipeline is not a stall. */
  paused: boolean
  /** Pending, non-excluded episodes inside the processing window. */
  pendingCount: number
  /** created_at of the oldest such pending episode (ISO), or null. */
  oldestPendingAt: string | null
  /** created_at of the station's most recent transcription usage row (ISO), or null. */
  lastTranscribedAt: string | null
  now?: Date
}

export interface TranscriptionStall {
  pendingCount: number
  /** When work last moved: the later of last transcription and oldest wait start. */
  stalledSince: string
  hours: number
}

export function detectTranscriptionStall(input: StallInputs): TranscriptionStall | null {
  const { paused, pendingCount, oldestPendingAt, lastTranscribedAt } = input
  if (paused || pendingCount <= 0 || !oldestPendingAt) return null
  const now = (input.now ?? new Date()).getTime()

  const waitingSince = Date.parse(oldestPendingAt)
  if (!Number.isFinite(waitingSince) || now - waitingSince < STALL_THRESHOLD_MS) return null

  // Something waiting 2h+ is fine if the worker is actively draining a backlog.
  const lastDone = lastTranscribedAt ? Date.parse(lastTranscribedAt) : NaN
  if (Number.isFinite(lastDone) && now - lastDone < STALL_THRESHOLD_MS) return null

  // The stall began when the worker last made progress — or, if work only
  // arrived after that, when the oldest episode started waiting.
  const since = Number.isFinite(lastDone) ? Math.max(lastDone, waitingSince) : waitingSince
  return {
    pendingCount,
    stalledSince: new Date(since).toISOString(),
    hours: Math.floor((now - since) / 3_600_000),
  }
}
