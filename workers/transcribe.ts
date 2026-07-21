import { Job } from 'bullmq'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { supabaseAdmin } from '../lib/supabase'
import { logTranscriptionUsage } from '../lib/usage'
import { getExcludedCategories, getTranscribeBatchSize, isPipelinePaused, isDiarizationEnabled } from '../lib/settings'
import { isSpendLimitError } from '../lib/retry-policy'
import { getCurrentQuarterBounds } from '../lib/quarters'
import { parseVtt } from '../lib/vtt'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { withStationStageLock } from '../lib/locks'
import { resolveProviderPlan, runTranscription, AudioUnavailableError } from '../lib/transcription'
import { applyCorrections, buildVtt } from '../lib/transcription/vtt'

// Replace an episode's timed search cues from its freshly-built VTT. Auxiliary
// to the transcript itself: a failure here must never fail the episode (search
// degrades to the runtime VTT aligner), so callers swallow errors.
async function populateCues(episodeId: number, vtt: string): Promise<void> {
  const cues = parseVtt(vtt)
  // Idempotent per episode: clear then re-insert so re-transcribes don't dup.
  await supabaseAdmin.from('transcript_cues').delete().eq('episode_id', episodeId)
  if (!cues.length) return
  const rows = cues.map((c) => ({
    episode_id: episodeId,
    cue_idx: c.index,
    start_ms: c.startMs,
    end_ms: c.endMs,
    text: c.text,
  }))
  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await supabaseAdmin.from('transcript_cues').insert(rows.slice(k, k + 500))
    if (error) throw new Error(error.message)
  }
}

const execFileAsync = promisify(execFile)

const MAX_CHUNK_SIZE_BYTES = 25 * 1024 * 1024 // 25MB
const CHUNK_DURATION_SECONDS = 900 // 15 minutes

/**
 * Date window for candidate selection. Defaults to the current quarter (steady
 * state), but a job may carry an explicit `{ window: { start, end } }` to drive a
 * historical backfill past the current-quarter gate. The continue/backoff/chain
 * re-enqueues (workers/index.ts) thread the same window through so the whole drain
 * stays scoped. See scripts/backfill-quarter.ts.
 */
function resolveWindow(job: Job): { start: string; end: string } {
  const w = job.data?.window as { start?: string; end?: string } | undefined
  if (w?.start && w?.end) return { start: w.start, end: w.end }
  return getCurrentQuarterBounds()
}

async function loadCorrections(stationId: string): Promise<
  Array<{ wrong: string; correct: string; caseSensitive: boolean; isRegex: boolean }>
> {
  const { data } = await supabaseAdmin
    .from('transcript_corrections')
    .select('wrong, correct, case_sensitive, is_regex')
    .eq('station_id', stationId)
    .eq('active', true)

  return (data ?? []).map((c) => ({
    wrong: c.wrong,
    correct: c.correct,
    caseSensitive: c.case_sensitive,
    isRegex: c.is_regex,
  }))
}

// Lazily produce 15-min M4A chunk paths for the Groq path. Memoized per episode
// so a fallback that re-runs Groq won't re-chunk, and never invoked at all when a
// URL-based provider (Deepgram/AssemblyAI) handles the episode. Throws
// AudioUnavailableError on a 404 so the caller marks the episode `unavailable`.
function makeChunkLoader(mp3Url: string, tmpDir: string): () => Promise<string[]> {
  let cached: string[] | null = null
  return async () => {
    if (cached) return cached
    await fs.mkdir(tmpDir, { recursive: true })
    const chunkPattern = path.join(tmpDir, 'chunk_%03d.m4a')
    try {
      await execFileAsync('ffmpeg', [
        '-i', mp3Url,
        '-f', 'segment',
        '-segment_time', String(CHUNK_DURATION_SECONDS),
        '-reset_timestamps', '1',
        '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'aac', '-b:a', '64k',
        chunkPattern,
      ], { timeout: 600_000 }) // 10 min timeout
    } catch (ffErr: unknown) {
      const errMsg = ffErr instanceof Error ? ffErr.message : String(ffErr)
      // Only a literal 404 is terminal `unavailable`. ffmpeg reports every
      // HTTP status as "Server returned <code> ..." — a 403/5xx must stay a
      // retryable failure, and a bare '404' substring can appear in the MP3
      // filename itself (any April 4 air date), so match the full phrase.
      if (/Server returned 404|HTTP error 404/.test(errMsg)) {
        throw new AudioUnavailableError('MP3 not found (404)')
      }
      throw ffErr
    }

    const files = await fs.readdir(tmpDir)
    const chunkFiles = files
      .filter((f) => f.startsWith('chunk_') && f.endsWith('.m4a'))
      .sort()
    if (!chunkFiles.length) throw new Error('ffmpeg produced no chunk files')

    // Verify chunk sizes — Groq rejects >25MB. Shouldn't happen at 15min/64k.
    for (const chunkFile of chunkFiles) {
      const stat = await fs.stat(path.join(tmpDir, chunkFile))
      if (stat.size > MAX_CHUNK_SIZE_BYTES) {
        throw new Error(`Chunk ${chunkFile} exceeds 25MB — needs shorter segment time`)
      }
    }

    cached = chunkFiles.map((f) => path.join(tmpDir, f))
    return cached
  }
}

export async function processTranscribe(job: Job) {
  // Workers run with the service-role client (RLS bypassed), so the station_id
  // filter below is the ONLY guard against processing another station's episodes.
  const stationId = job.data?.stationId as string | undefined
  if (!stationId) throw new Error('[transcribe] stationId is required in job data')
  // A windowed job is an explicit operator backfill — it runs even when the
  // STATION is parked (per-station pause), but still honors the GLOBAL kill
  // switch. A normal (live) job respects the per-station pause as before.
  // Checked before the lock so a paused station never takes a lock.
  const paused = job.data?.window ? await isPipelinePaused() : await isPipelinePaused(stationId)
  if (paused) {
    console.log(`[transcribe] paused (${job.data?.window ? 'global' : `station ${stationId}`}) — skipping`)
    return { transcribed: 0, remaining: false, skipped: true }
  }

  // One chain per (station, transcribe): with transcribe concurrency ≥ 2, this
  // lock stops a single station from occupying both slots. If another chain for
  // this station is already draining, skip — it re-queues its own continuation.
  return withStationStageLock(
    stationId,
    'transcribe',
    () => runTranscribeBatch(job, stationId),
    { transcribed: 0, remaining: false, skipped: 'locked' as const },
  )
}

async function runTranscribeBatch(job: Job, stationId: string) {
  console.log(`[transcribe] starting batch for station ${stationId}...`)

  const excludedCategories = await getExcludedCategories(stationId)
  const batchSize = await getTranscribeBatchSize(stationId)
  const { start, end } = resolveWindow(job)

  // Resolve the provider fallback plan once per batch (it's station-level config,
  // not per-episode). If nothing is enabled+configured, bail BEFORE claiming so a
  // misconfiguration doesn't mark episodes failed and burn their retries.
  let providerPlan = await resolveProviderPlan(stationId)
  if (!providerPlan.length) {
    console.warn(`[transcribe] no transcription provider enabled+configured for station ${stationId} — skipping`)
    return { transcribed: 0, skipped: 'no-provider' as const }
  }
  let diarize = await isDiarizationEnabled(stationId)
  // Windowed backfills go through Groq ONLY (cheap chunked Whisper), no diarization:
  // speaker labels aren't needed for a historical QIR, and the fallback providers
  // (Deepgram/AssemblyAI) cost more and diarize. If Groq isn't configured for this
  // station, keep the resolved plan as a safety net rather than failing the backfill.
  if (job.data?.window) {
    const groqOnly = providerPlan.filter((p) => p.id === 'groq')
    if (groqOnly.length) {
      providerPlan = groqOnly
      diarize = false
    } else {
      console.warn('[transcribe] windowed backfill but groq not configured — using full provider plan')
    }
  }
  console.log(`[transcribe] provider order: ${providerPlan.map((p) => p.id).join(' → ')} (diarize=${diarize})`)

  // Get candidate pending episodes from the window (including those with null
  // air_date that were created during it — older ingests didn't populate it).
  // Audit-flagged `priority` episodes are also pulled in regardless of window, and
  // ordered ahead of the backlog, so a compliance audit can complete any show's data.
  // NOTE: we deliberately do NOT `.limit(batchSize)` here. Excluded categories must
  // be dropped BEFORE the batch is sliced: with a small batch size, a run of
  // excluded-category episodes at the head of the created_at order (e.g. a backfill's
  // block of Music episodes) would otherwise fill the entire batch, claim nothing,
  // and dead-end the continue-chain while claimable episodes sit right behind them.
  // id+category over one window is small, so fetching all then slicing is cheap.
  const { data: candidates, error } = await supabaseAdmin
    .from('episode_log')
    .select('id, category')
    .eq('station_id', stationId)
    .eq('status', 'pending')
    .or(`priority.is.true,and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)

  // Drop excluded categories before slicing the batch so they stay pending (never
  // claimed, never stuck mid-stage) without starving claimable work. A null category
  // is never excluded — matches getExcludedCategories' substring semantics.
  const claimable = (candidates ?? []).filter(
    (ep) => !excludedCategories.some((exc) => ep.category?.includes(exc)),
  )
  if (!claimable.length) {
    // Nothing pending, or only excluded-category episodes remain — both are a clean
    // terminal state for this stage (excluded ones are meant to stay pending).
    console.log('[transcribe] no claimable pending episodes')
    return { transcribed: 0, remaining: false }
  }
  const claimIds = claimable.slice(0, batchSize).map((ep) => ep.id)

  // Atomically claim: the `.eq('status', 'pending')` guard means only rows still
  // pending are flipped to 'transcribing', so overlapping runs (manual retry,
  // continue-chain, BullMQ attempts, cron) can never grab the same episode.
  const { data: episodes, error: claimError } = await supabaseAdmin
    .from('episode_log')
    .update({ status: 'transcribing', updated_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .in('id', claimIds)
    .eq('status', 'pending')
    .select('*')

  if (claimError) throw new Error(`Failed to claim episodes: ${claimError.message}`)
  if (!episodes?.length) {
    console.log('[transcribe] no episodes claimed (already taken by another run)')
    return { transcribed: 0 }
  }

  const filteredEpisodes = episodes
  const corrections = await loadCorrections(stationId)
  let transcribed = 0

  for (let i = 0; i < filteredEpisodes.length; i++) {
    const episode = filteredEpisodes[i]
    await job.updateProgress({ current: i + 1, total: filteredEpisodes.length, episodeId: episode.id, showName: episode.show_name || episode.show_key, airDate: episode.air_date })
    // Unique temp dir per run — a deterministic per-episode path lets overlapping
    // jobs (manual retry, continue-chain, BullMQ attempts, cron) delete each other's
    // chunks mid-transcription, surfacing as ENOENT on a later chunk.
    const runId = `${job.id ?? 'job'}-${Math.random().toString(36).slice(2, 10)}`
    const tmpDir = path.join(os.tmpdir(), 'qir-audio', `ep-${episode.id}-${runId}`)
    try {
      // Run the provider plan (priority order, automatic fallback). Groq pulls the
      // ffmpeg chunks via getLocalChunks; Deepgram/AssemblyAI fetch the mp3_url
      // directly, so the chunk loader only runs if a chunk-based provider is used.
      const result = await runTranscription(
        {
          episodeId: episode.id,
          mp3Url: episode.mp3_url,
          diarize,
          chunkDurationSec: CHUNK_DURATION_SECONDS,
          getLocalChunks: makeChunkLoader(episode.mp3_url, tmpDir),
        },
        providerPlan,
      )

      // Stitch and apply corrections. Speaker labels (when diarized) go into the
      // VTT as voice spans; the plain transcript stays speaker-free for summarize.
      const correctedTranscript = applyCorrections(result.text, corrections)
      const vtt = buildVtt(result.segments, corrections, result.diarized)
      const totalDuration = result.durationSec

      // Store transcript — check for errors before marking episode as transcribed
      const { error: upsertError } = await supabaseAdmin.from('transcripts').upsert(
        {
          episode_id: episode.id,
          transcript: correctedTranscript,
          vtt,
          language: result.language,
          provider: result.providerId,
          model: result.model,
          english_transcript: null,
          english_vtt: null,
        },
        { onConflict: 'episode_id' }
      )

      if (upsertError) {
        throw new Error(`Failed to store transcript: ${upsertError.message}`)
      }

      // Verify transcript was actually stored before updating status
      const { count: transcriptCount } = await supabaseAdmin
        .from('transcripts')
        .select('episode_id', { count: 'exact', head: true })
        .eq('episode_id', episode.id)

      if (!transcriptCount || transcriptCount === 0) {
        throw new Error('Transcript upsert succeeded but row not found — possible constraint or RLS issue')
      }

      // Update episode status. Fill duration when it's missing (a backfill, or any
      // RSS feed that omitted itunes:duration, ships a null duration) — transcription
      // knows the true audio length. Never overwrite an existing duration.
      const durationMinutes =
        episode.duration == null && Number.isFinite(totalDuration)
          ? Math.max(1, Math.round(totalDuration / 60))
          : undefined
      await supabaseAdmin
        .from('episode_log')
        .update({
          status: 'transcribed',
          error_message: null,
          ...(durationMinutes !== undefined ? { duration: durationMinutes } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('id', episode.id)

      // Populate timed search cues from the VTT (best-effort — never fail the
      // episode over auxiliary search data).
      try {
        await populateCues(episode.id, vtt)
      } catch (cueErr) {
        console.warn(`[transcribe] ep ${episode.id} cue population failed:`, cueErr instanceof Error ? cueErr.message : cueErr)
      }

      // Log usage against the provider that actually ran (cost is provider-rated).
      await logTranscriptionUsage(stationId, episode.id, totalDuration, {
        provider: result.providerId,
        model: result.model,
        metadata: { diarized: result.diarized },
      })

      transcribed++
      console.log(`[transcribe] ep ${episode.id} done via ${result.providerId} (${Math.round(totalDuration)}s${result.diarized ? ', diarized' : ''})`)
    } catch (err) {
      // A genuinely missing MP3 is terminal — mark unavailable, don't burn a retry
      // or fall through to "failed" (no provider can fetch a 404).
      if (err instanceof AudioUnavailableError) {
        await supabaseAdmin
          .from('episode_log')
          .update({ status: 'unavailable', error_message: err.message, updated_at: new Date().toISOString() })
          .eq('id', episode.id)
        console.warn(`[transcribe] episode ${episode.id} unavailable: ${err.message}`)
        continue
      }
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[transcribe] ep ${episode.id} failed:`, errMsg)
      // A spend-limit block is org-wide, not this episode's fault — don't spend
      // a retry on it, or a billing outage will eventually mark the backlog dead.
      const spendBlocked = isSpendLimitError(errMsg)
      await supabaseAdmin
        .from('episode_log')
        .update({
          status: 'failed',
          error_message: errMsg.slice(0, 1000),
          retry_count: spendBlocked ? (episode.retry_count ?? 0) : (episode.retry_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', episode.id)
    } finally {
      // Clean up temp files
      try {
        await fs.rm(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  // More claimable pending beyond this batch? Excluded-category episodes are NOT
  // counted — they intentionally stay `pending` and must not keep the chain alive
  // (counting them was the other half of the backfill deadlock). Audit `priority`
  // episodes are already part of `claimable` (the candidate query pulls them in),
  // so this in-memory check covers them too. The continue job re-queries fresh, so
  // a slight over-estimate just costs one extra empty tick.
  const remaining = claimable.length > claimIds.length
  if (remaining) {
    console.log(`[transcribe] ${claimable.length - claimIds.length} more claimable pending — will continue`)
  }

  if (transcribed > 0) {
    void logAuditEvent({
      action: AUDIT_ACTIONS.TRANSCRIBE_COMPLETE,
      operation: 'update',
      stationId,
      resourceType: 'episode',
      metadata: { transcribed, remaining },
    })
  }
  return { transcribed, remaining }
}
