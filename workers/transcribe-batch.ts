// Groq Batch API for transcription backlogs — half price, results within 24h.
//
// Two entry points:
//   submitBacklogBatch() — called by the transcribe worker (inside its station
//     lock) BEFORE it claims sync work. Picks the backlog episodes that have
//     already waited (lib/transcription/batch-policy.ts), checks each MP3 fits
//     Groq's URL-audio size limit, moves them pending → batch_queued, and
//     submits one Groq batch. Returns the ids it took; never throws — any
//     trouble puts the episodes back to pending for the sync path.
//   processBatchPoll() — a 10-minute cron. For every open batch: ask Groq for
//     its status; when it's done, store each transcript through the SAME code as
//     the sync path (storeTranscriptionResult) at the batch rate, send failures
//     back to pending (sync-only from then on: batch_attempted_at is set), and
//     chain summarize. Also sweeps episodes stranded in batch_queued.
//
// Nothing here can strand an episode: every exit path either transcribes it or
// returns it to `pending`.

import type { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { getTranscriptionBatchSettings, isPipelinePaused, isVocabularyHintEnabled } from '../lib/settings'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { summarizeQueue, transcribeQueue } from '../lib/queue'
import { jobPriority } from '../lib/tier'
import { pickBatchCandidates, fitsBatchSizeLimit, type BatchSettings } from '../lib/transcription/batch-policy'
import {
  buildBatchJsonl,
  uploadBatchFile,
  createBatch,
  getBatch,
  downloadFile,
  parseBatchOutput,
  whisperToResult,
  isTerminalBatchStatus,
  probeContentLength,
  type BatchRequestInput,
  type BatchLineResult,
} from '../lib/transcription/groq-batch'
import { loadCorrectionRules, loadShowGroups, loadVocabulary, episodeHumanNames } from '../lib/transcription/store'
import { buildVocabularyPrompt, shouldUseVocabularyHint } from '../lib/transcription/vocabulary'
import { storeTranscriptionResult } from './transcribe'

const PROBE_CONCURRENCY = 8
/** A row stuck in 'submitting' this long crashed between insert and Groq create. */
const SUBMITTING_STALE_MS = 30 * 60_000
/** Groq expires a 24h batch itself; this only catches a batch Groq lost track of. */
const SUBMITTED_GIVE_UP_MS = 72 * 60 * 60_000

type Claimable = { id: number; created_at: string; priority?: boolean | null; batch_attempted_at?: string | null }

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx])
      }
    }),
  )
  return out
}

/** Back to the sync path. batch_attempted_at stays set, so it's never re-batched. */
async function returnToSync(stationId: string, ids: number[], reason: string) {
  if (!ids.length) return
  await supabaseAdmin
    .from('episode_log')
    .update({ status: 'pending', error_message: reason.slice(0, 1000), updated_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .in('id', ids)
    .eq('status', 'batch_queued')
}

/**
 * Return a batch's episodes to sync AND start a transcribe run for them, carrying
 * the batch's window: a historical backfill's chain may already have ended, and
 * the startup/4-hourly kick only covers the current quarter, so without this a
 * returned backfill episode would sit in pending forever. The processor enforces
 * pause; the stage lock makes an overlapping run a no-op.
 */
async function returnRowToSync(row: BatchRow, ids: number[], reason: string) {
  if (!ids.length) return
  await returnToSync(row.station_id, ids, reason)
  const window = row.job_window ? { window: row.job_window } : {}
  await transcribeQueue.add(
    'batch-fallback',
    { stationId: row.station_id, ...window, source: 'chain', chain: true },
    { priority: await jobPriority(row.station_id) },
  )
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export async function submitBacklogBatch(
  job: Job,
  stationId: string,
  claimable: Claimable[],
  model: string,
): Promise<Set<number>> {
  const taken = new Set<number>()
  let settings: BatchSettings
  try {
    settings = await getTranscriptionBatchSettings(stationId)
  } catch {
    return taken
  }
  const windowed = !!job.data?.window
  const candidates = pickBatchCandidates(
    claimable.map((c) => ({ id: c.id, created_at: c.created_at, priority: c.priority, neverBatched: !c.batch_attempted_at })),
    settings,
    { windowed },
  )
  if (!candidates.length) return taken

  let batchRowId: number | null = null
  let claimedIds: number[] = []
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('episode_log')
      .select('id, mp3_url, show_key, category, field_sources')
      .eq('station_id', stationId)
      .in('id', candidates.map((c) => c.id))
    if (error) throw new Error(error.message)

    // Size gate — Groq fetches the MP3 by URL and caps it (100 MB on the dev tier).
    // A file definitely over the limit is marked batch-attempted so we don't
    // re-probe it on every tick; an unknown size just stays sync this time.
    const sized = await mapLimit(rows ?? [], PROBE_CONCURRENCY, async (r) => ({ r, bytes: await probeContentLength(r.mp3_url) }))
    const fits = sized.filter((x) => fitsBatchSizeLimit(x.bytes, settings)).map((x) => x.r)
    const tooBig = sized.filter((x) => x.bytes != null && !fitsBatchSizeLimit(x.bytes, settings)).map((x) => x.r.id)
    if (tooBig.length) {
      await supabaseAdmin.from('episode_log').update({ batch_attempted_at: new Date().toISOString() })
        .eq('station_id', stationId).in('id', tooBig)
    }
    if (!fits.length) return taken

    // Atomic claim, same guard as the sync path: only rows still pending move.
    const now = new Date().toISOString()
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from('episode_log')
      .update({ status: 'batch_queued', batch_attempted_at: now, updated_at: now })
      .eq('station_id', stationId)
      .in('id', fits.map((r) => r.id))
      .eq('status', 'pending')
      .select('id')
    if (claimErr) throw new Error(claimErr.message)
    claimedIds = (claimed ?? []).map((c) => c.id as number)
    if (!claimedIds.length) return taken
    const claimedSet = new Set(claimedIds)
    const items = fits.filter((r) => claimedSet.has(r.id))

    // Same vocabulary hint rules as the sync path (off by default; never Music).
    let promptStationTerms: string[] | null = null
    const prompts: Record<string, string> = {}
    if (await isVocabularyHintEnabled(stationId)) {
      const { groupOf } = await loadShowGroups(supabaseAdmin, stationId)
      const vocab = await loadVocabulary(supabaseAdmin, stationId, groupOf)
      promptStationTerms = vocab.stationTerms
      for (const r of items) {
        if (!shouldUseVocabularyHint(r.category)) continue
        const p = buildVocabularyPrompt({
          stationTerms: vocab.stationTerms,
          showNames: vocab.namesForShow(r.show_key),
          episodeNames: episodeHumanNames(r.field_sources),
        })
        if (p) prompts[String(r.id)] = p
      }
    }

    const { data: batchRow, error: insErr } = await supabaseAdmin
      .from('transcription_batches')
      .insert({
        station_id: stationId,
        model,
        status: 'submitting',
        episode_ids: claimedIds,
        job_window: job.data?.window ?? null,
        prompts: Object.keys(prompts).length ? prompts : null,
        prompt_station_terms: promptStationTerms,
      })
      .select('id')
      .single()
    if (insErr || !batchRow) throw new Error(`batch row insert: ${insErr?.message ?? 'no row'}`)
    batchRowId = batchRow.id as number

    const requests: BatchRequestInput[] = items.map((r) => ({
      episodeId: r.id,
      mp3Url: r.mp3_url,
      ...(prompts[String(r.id)] ? { prompt: prompts[String(r.id)] } : {}),
    }))
    const fileId = await uploadBatchFile(buildBatchJsonl(requests, model), `qir-${stationId.slice(0, 8)}-${batchRowId}.jsonl`)
    const batch = await createBatch(fileId, { qir_batch: String(batchRowId), station: stationId })
    await supabaseAdmin
      .from('transcription_batches')
      .update({ provider_batch_id: batch.id, input_file_id: fileId, status: 'submitted', provider_status: batch.status, updated_at: new Date().toISOString() })
      .eq('id', batchRowId)

    claimedIds.forEach((id) => taken.add(id))
    console.log(`[transcribe:batch] station ${stationId}: ${claimedIds.length} backlog episode(s) → Groq batch ${batch.id} (half price, ≤24h)`)
    void logAuditEvent({
      action: AUDIT_ACTIONS.TRANSCRIBE_BATCH_SUBMITTED,
      operation: 'insert',
      stationId,
      resourceType: 'transcription_batch',
      resourceId: String(batchRowId),
      metadata: { episodes: claimedIds.length, providerBatchId: batch.id, windowed },
    })
    return taken
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[transcribe:batch] submit failed for station ${stationId} — falling back to sync:`, msg)
    await returnToSync(stationId, claimedIds, `Batch submit failed, sent to normal transcription: ${msg}`)
    if (batchRowId != null) {
      await supabaseAdmin.from('transcription_batches')
        .update({ status: 'failed', error: msg.slice(0, 1000), returned_to_sync: claimedIds.length, updated_at: new Date().toISOString() })
        .eq('id', batchRowId)
    }
    return new Set<number>()
  }
}

// ---------------------------------------------------------------------------
// Poll + collect
// ---------------------------------------------------------------------------

interface BatchRow {
  id: number
  station_id: string
  provider_batch_id: string | null
  model: string
  status: string
  episode_ids: number[]
  job_window: { start: string; end: string } | null
  prompts: Record<string, string> | null
  prompt_station_terms: string[] | null
  submitted_at: string
}

export async function processBatchPoll(_job: Job) {
  const { data: open, error } = await supabaseAdmin
    .from('transcription_batches')
    .select('id, station_id, provider_batch_id, model, status, episode_ids, job_window, prompts, prompt_station_terms, submitted_at')
    .in('status', ['submitting', 'submitted'])
    .order('submitted_at', { ascending: true })
  if (error) throw new Error(`open batches: ${error.message}`)

  let collected = 0
  for (const row of (open ?? []) as BatchRow[]) {
    try {
      collected += await pollOne(row)
    } catch (err) {
      // One bad batch must not block the others; it's retried next tick — until
      // the give-up age. A batch Groq can no longer return (getBatch or the file
      // download failing every tick) must not hold its episodes forever.
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[transcribe:batch] poll of batch ${row.id} failed:`, msg)
      if (Date.now() - Date.parse(row.submitted_at) > SUBMITTED_GIVE_UP_MS) {
        try {
          await returnRowToSync(row, row.episode_ids, `Groq batch unreadable after 72h — sent to normal transcription: ${msg}`)
          await closeRow(row, { status: 'failed', error: `gave up after 72h: ${msg}`.slice(0, 1000), returned_to_sync: row.episode_ids.length })
        } catch (giveUpErr) {
          console.error(`[transcribe:batch] give-up of batch ${row.id} failed:`, giveUpErr instanceof Error ? giveUpErr.message : giveUpErr)
        }
      }
    }
  }
  const swept = await sweepStranded()
  return { open: open?.length ?? 0, collected, swept }
}

async function closeRow(row: BatchRow, fields: Record<string, unknown>) {
  await supabaseAdmin.from('transcription_batches')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', row.id)
}

async function pollOne(row: BatchRow): Promise<number> {
  const age = Date.now() - Date.parse(row.submitted_at)

  if (row.status === 'submitting' || !row.provider_batch_id) {
    if (age < SUBMITTING_STALE_MS) return 0
    await returnRowToSync(row, row.episode_ids, 'Batch submit never completed — sent to normal transcription')
    await closeRow(row, { status: 'failed', error: 'stuck in submitting', returned_to_sync: row.episode_ids.length })
    return 0
  }

  const remote = await getBatch(row.provider_batch_id)
  if (!isTerminalBatchStatus(remote.status)) {
    if (age > SUBMITTED_GIVE_UP_MS) {
      await returnRowToSync(row, row.episode_ids, `Groq batch ${remote.status} after 72h — sent to normal transcription`)
      await closeRow(row, { status: 'failed', provider_status: remote.status, error: 'gave up after 72h', returned_to_sync: row.episode_ids.length })
    } else {
      await closeRow(row, { provider_status: remote.status })
    }
    return 0
  }

  // Terminal. Gather every line Groq returned (output + error files).
  const lines: BatchLineResult[] = []
  if (remote.output_file_id) lines.push(...parseBatchOutput(await downloadFile(remote.output_file_id)))
  if (remote.error_file_id) lines.push(...parseBatchOutput(await downloadFile(remote.error_file_id)))

  const mine = new Set(row.episode_ids)
  const byId = new Map<number, BatchLineResult>()
  for (const l of lines) if (mine.has(l.episodeId)) byId.set(l.episodeId, l)

  const corrections = await loadCorrectionRules(supabaseAdmin, row.station_id)
  const { groupOf } = await loadShowGroups(supabaseAdmin, row.station_id)
  const { data: eps, error: epsErr } = await supabaseAdmin
    .from('episode_log')
    .select('id, show_key, duration, status')
    .eq('station_id', row.station_id)
    .in('id', row.episode_ids)
  // Throw rather than close the batch on an empty read: closing it would let the
  // sweep send already-paid results back to be transcribed (and paid for) again.
  // The poll loop leaves the batch open and retries next tick.
  if (epsErr) throw new Error(`episode read for batch ${row.id}: ${epsErr.message}`)

  let transcribed = 0
  const back: number[] = []
  const reasons: string[] = []
  for (const ep of eps ?? []) {
    if (ep.status !== 'batch_queued') continue // someone retried it by hand meanwhile
    const line = byId.get(ep.id)
    if (!line || !line.ok) {
      back.push(ep.id)
      if (line && !line.ok && reasons.length < 3) reasons.push(line.error)
      continue
    }
    try {
      const prompt = row.prompts?.[String(ep.id)]
      const result = whisperToResult(line.whisper, row.model, prompt, row.prompt_station_terms ?? undefined)
      await storeTranscriptionResult(row.station_id, ep, result, corrections, groupOf, { batch: true })
      transcribed++
    } catch (err) {
      back.push(ep.id)
      if (reasons.length < 3) reasons.push(err instanceof Error ? err.message : String(err))
    }
  }

  const why = remote.status === 'completed'
    ? 'Groq batch item failed — sent to normal transcription'
    : `Groq batch ${remote.status} — sent to normal transcription`
  await returnRowToSync(row, back, reasons[0] ? `${why}: ${reasons[0]}` : why)
  await closeRow(row, {
    status: remote.status === 'completed' || transcribed > 0 ? 'collected' : 'failed',
    provider_status: remote.status,
    output_file_id: remote.output_file_id ?? null,
    error_file_id: remote.error_file_id ?? null,
    transcribed,
    returned_to_sync: back.length,
    error: reasons.length ? reasons.join(' | ').slice(0, 1000) : null,
    collected_at: new Date().toISOString(),
  })
  console.log(`[transcribe:batch] batch ${row.id} (${remote.status}): ${transcribed} transcribed, ${back.length} back to sync`)
  void logAuditEvent({
    action: AUDIT_ACTIONS.TRANSCRIBE_BATCH_COLLECTED,
    operation: 'update',
    stationId: row.station_id,
    resourceType: 'transcription_batch',
    resourceId: String(row.id),
    metadata: { providerStatus: remote.status, transcribed, returnedToSync: back.length },
  })

  // Hand the new transcripts to summarize (→ compliance), exactly like the sync
  // chain. A windowed backfill bypasses the per-station pause (global still stops it).
  const window = row.job_window ? { window: row.job_window } : {}
  const paused = row.job_window ? await isPipelinePaused() : await isPipelinePaused(row.station_id)
  if (transcribed > 0 && !paused) {
    await summarizeQueue.add('chain-summarize', { stationId: row.station_id, ...window, source: 'chain', chain: true }, { priority: await jobPriority(row.station_id) })
  }
  return transcribed
}

/**
 * Safety net: an episode in batch_queued whose batch row is closed (or missing)
 * was dropped somewhere — return it to the sync path.
 */
async function sweepStranded(): Promise<number> {
  const { data: queued } = await supabaseAdmin
    .from('episode_log')
    .select('id, station_id')
    .eq('status', 'batch_queued')
    // Skip anything touched in the last 30 min: submit claims episodes a moment
    // before it writes their batch row, and must not have them swept mid-submit.
    .lt('updated_at', new Date(Date.now() - SUBMITTING_STALE_MS).toISOString())
    .limit(1000)
  if (!queued?.length) return 0
  const { data: open } = await supabaseAdmin
    .from('transcription_batches')
    .select('episode_ids')
    .in('status', ['submitting', 'submitted'])
  const live = new Set<number>((open ?? []).flatMap((r) => r.episode_ids as number[]))
  const stranded = queued.filter((q) => !live.has(q.id))
  const byStation = new Map<string, number[]>()
  for (const s of stranded) byStation.set(s.station_id, [...(byStation.get(s.station_id) ?? []), s.id])
  for (const [stationId, ids] of byStation) {
    await returnToSync(stationId, ids, 'Batch record closed without this episode — sent to normal transcription')
  }
  if (stranded.length) console.warn(`[transcribe:batch] returned ${stranded.length} stranded batch_queued episode(s) to sync`)
  return stranded.length
}
