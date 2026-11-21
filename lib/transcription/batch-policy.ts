// Which pending episodes go to the Groq Batch API (half price, ≤24h) instead of
// the synchronous path. Pure — the worker supplies the facts, this decides.
//
// Policy ("backlogs only", chosen 2026-11): batch is for catching up, not for
// everyday flow. Fresh episodes keep the fast path so the public episode feed and
// flag review stay same-day; only when work has piled up do the episodes that
// have ALREADY waited a while move to batch, where another few hours costs
// nothing and halves the bill. Historical (windowed) backfills always prefer batch.

export interface BatchSettings {
  enabled: boolean
  /** Claimable pending episodes needed before batch kicks in. */
  backlogThreshold: number
  /** An episode must have waited at least this long to be batched. */
  minAgeHours: number
  /** Groq's URL-audio limit (100 MB on the dev tier). Bigger files stay sync. */
  maxFileMb: number
  /** Cap per Groq batch file (Groq allows 50k lines; smaller batches finish sooner). */
  maxPerBatch: number
}

export const DEFAULT_BATCH_SETTINGS: BatchSettings = {
  enabled: true,
  backlogThreshold: 20,
  minAgeHours: 6,
  maxFileMb: 100,
  maxPerBatch: 200,
}

/** Merge a stored (possibly partial / malformed) setting over the defaults. */
export function resolveBatchSettings(raw: unknown): BatchSettings {
  const s = { ...DEFAULT_BATCH_SETTINGS }
  if (!raw || typeof raw !== 'object') return s
  const r = raw as Record<string, unknown>
  if (typeof r.enabled === 'boolean') s.enabled = r.enabled
  const num = (v: unknown, min: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : null)
  s.backlogThreshold = num(r.backlog_threshold, 1) ?? s.backlogThreshold
  s.minAgeHours = num(r.min_age_hours, 0) ?? s.minAgeHours
  s.maxFileMb = num(r.max_file_mb, 1) ?? s.maxFileMb
  s.maxPerBatch = Math.floor(num(r.max_per_batch, 1) ?? s.maxPerBatch)
  return s
}

export interface BatchCandidate {
  id: number
  created_at: string
  /** Never batched before (episode_log.batch_attempted_at is null). */
  neverBatched: boolean
  /** Audit-flagged priority work is wanted now — never batch it. */
  priority?: boolean | null
}

/**
 * Episodes eligible for batch BEFORE the file-size check (which needs a HEAD
 * request per file, so the worker only probes these). Oldest first, capped.
 * `claimable` is the full claimable set (it sets the backlog size).
 */
export function pickBatchCandidates(
  claimable: BatchCandidate[],
  settings: BatchSettings,
  opts: { windowed: boolean; now?: Date },
): BatchCandidate[] {
  if (!settings.enabled) return []
  if (!opts.windowed && claimable.length < settings.backlogThreshold) return []
  const now = (opts.now ?? new Date()).getTime()
  const minAgeMs = settings.minAgeHours * 3_600_000
  return claimable
    .filter((ep) => ep.neverBatched && !ep.priority)
    .filter((ep) => opts.windowed || now - Date.parse(ep.created_at) >= minAgeMs)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, settings.maxPerBatch)
}

/** Size gate. Unknown size (no Content-Length) stays on the sync path — safe default. */
export function fitsBatchSizeLimit(contentLength: number | null, settings: BatchSettings): boolean {
  return contentLength != null && contentLength > 0 && contentLength <= settings.maxFileMb * 1024 * 1024
}
