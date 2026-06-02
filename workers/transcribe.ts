import { Job } from 'bullmq'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { supabaseAdmin } from '../lib/supabase'
import { logTranscriptionUsage } from '../lib/usage'
import { getExcludedCategories, getTranscribeBatchSize, isPipelinePaused } from '../lib/settings'
import { isSpendLimitError } from '../lib/retry-policy'
import { parseVtt } from '../lib/vtt'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { withStationStageLock } from '../lib/locks'

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

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MAX_CHUNK_SIZE_BYTES = 25 * 1024 * 1024 // 25MB
const CHUNK_DURATION_SECONDS = 900 // 15 minutes
const INTER_CHUNK_DELAY_MS = 1500 // 1.5s between API calls

interface WhisperSegment {
  start: number
  end: number
  text: string
}

interface WhisperResponse {
  text: string
  segments?: WhisperSegment[]
  duration?: number
  language?: string
}

function getCurrentQuarterBounds(): { start: string; end: string } {
  const now = new Date()
  const year = now.getFullYear()
  const quarter = Math.floor(now.getMonth() / 3)
  const startMonth = quarter * 3
  const start = new Date(year, startMonth, 1).toISOString().split('T')[0]
  const end = new Date(year, startMonth + 3, 0).toISOString().split('T')[0]
  return { start, end }
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

function applyCorrections(
  text: string,
  corrections: Array<{ wrong: string; correct: string; caseSensitive: boolean; isRegex: boolean }>
): string {
  let result = text
  for (const c of corrections) {
    if (c.isRegex) {
      const flags = c.caseSensitive ? 'g' : 'gi'
      try {
        result = result.replace(new RegExp(c.wrong, flags), c.correct)
      } catch (err) {
        console.warn(`[transcribe] Skipping invalid regex correction "${c.wrong}":`, err instanceof Error ? err.message : err)
      }
    } else {
      const flags = c.caseSensitive ? 'g' : 'gi'
      const escaped = c.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(escaped, flags), c.correct)
    }
  }
  return result
}

function buildVtt(
  allSegments: Array<{ chunkIndex: number; segments: WhisperSegment[] }>,
  corrections: Array<{ wrong: string; correct: string; caseSensitive: boolean; isRegex: boolean }>
): string {
  let vtt = 'WEBVTT\n\n'
  let cueIndex = 1

  for (const chunk of allSegments) {
    const offset = chunk.chunkIndex * CHUNK_DURATION_SECONDS
    for (const seg of chunk.segments) {
      const startTime = formatVttTime(seg.start + offset)
      const endTime = formatVttTime(seg.end + offset)
      const text = applyCorrections(seg.text.trim(), corrections)
      if (text) {
        vtt += `${cueIndex}\n${startTime} --> ${endTime}\n${text}\n\n`
        cueIndex++
      }
    }
  }

  return vtt
}

function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad3(ms)}`
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

async function transcribeChunk(chunkPath: string): Promise<WhisperResponse> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('GROQ_API_KEY not set')

  const fileData = await fs.readFile(chunkPath)
  const formData = new FormData()
  formData.append('file', new Blob([fileData]), path.basename(chunkPath))
  formData.append('model', 'whisper-large-v3')
  formData.append('response_format', 'verbose_json')

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: formData,
      signal: AbortSignal.timeout(5 * 60 * 1000), // 5 min timeout per chunk
    })

    if (response.ok) {
      return (await response.json()) as WhisperResponse
    }

    if (response.status === 429) {
      // Rate limited — exponential backoff
      const delay = Math.pow(2, attempt + 1) * 1000
      console.warn(`[transcribe] rate limited, retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
      lastError = new Error(`Groq rate limit (429) after ${attempt + 1} attempts`)
      continue
    }

    const body = await response.text()
    throw new Error(`Groq API error ${response.status}: ${body}`)
  }

  throw lastError ?? new Error('Groq API failed after retries')
}

export async function processTranscribe(job: Job) {
  if (await isPipelinePaused()) {
    console.log('[transcribe] pipeline paused — skipping')
    return { transcribed: 0, remaining: false, skipped: true }
  }
  // Workers run with the service-role client (RLS bypassed), so the station_id
  // filter below is the ONLY guard against processing another station's episodes.
  const stationId = job.data?.stationId as string | undefined
  if (!stationId) throw new Error('[transcribe] stationId is required in job data')

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
  const { start, end } = getCurrentQuarterBounds()

  // Get candidate pending episodes from current quarter (including those with null
  // air_date that were created during this quarter — older ingests didn't populate it)
  const { data: candidates, error } = await supabaseAdmin
    .from('episode_log')
    .select('id, category')
    .eq('station_id', stationId)
    .eq('status', 'pending')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!candidates?.length) {
    console.log('[transcribe] no pending episodes')
    return { transcribed: 0 }
  }

  // Drop excluded categories before claiming so they stay pending (not stuck mid-stage)
  const claimIds = candidates
    .filter((ep) => !excludedCategories.some((exc) => ep.category?.includes(exc)))
    .map((ep) => ep.id)

  if (!claimIds.length) {
    console.log('[transcribe] only excluded-category episodes pending')
    return { transcribed: 0 }
  }

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
      await fs.mkdir(tmpDir, { recursive: true })

      // Download and chunk with ffmpeg
      const chunkPattern = path.join(tmpDir, 'chunk_%03d.m4a')
      try {
        await execFileAsync('ffmpeg', [
          '-i', episode.mp3_url,
          '-f', 'segment',
          '-segment_time', String(CHUNK_DURATION_SECONDS),
          '-reset_timestamps', '1',
          '-vn', '-ac', '1', '-ar', '16000',
          '-c:a', 'aac', '-b:a', '64k',
          chunkPattern,
        ], { timeout: 600_000 }) // 10 min timeout
      } catch (ffErr: unknown) {
        const errMsg = ffErr instanceof Error ? ffErr.message : String(ffErr)
        if (errMsg.includes('404') || errMsg.includes('Server returned')) {
          await supabaseAdmin
            .from('episode_log')
            .update({ status: 'unavailable', error_message: 'MP3 not found (404)', updated_at: new Date().toISOString() })
            .eq('id', episode.id)
          console.warn(`[transcribe] episode ${episode.id} unavailable (404)`)
          continue
        }
        throw ffErr
      }

      // Find all chunk files
      const files = await fs.readdir(tmpDir)
      const chunkFiles = files
        .filter((f) => f.startsWith('chunk_') && f.endsWith('.m4a'))
        .sort()

      if (!chunkFiles.length) {
        throw new Error('ffmpeg produced no chunk files')
      }

      // Verify chunk sizes — re-chunk if any exceed 25MB
      for (const chunkFile of chunkFiles) {
        const stat = await fs.stat(path.join(tmpDir, chunkFile))
        if (stat.size > MAX_CHUNK_SIZE_BYTES) {
          console.warn(
            `[transcribe] chunk ${chunkFile} is ${Math.round(stat.size / 1024 / 1024)}MB, exceeds 25MB limit`
          )
          // This shouldn't happen with 15min/64k settings, but flag it
          throw new Error(`Chunk ${chunkFile} exceeds 25MB — needs shorter segment time`)
        }
      }

      // Transcribe each chunk
      const allTexts: string[] = []
      const allSegments: Array<{ chunkIndex: number; segments: WhisperSegment[] }> = []
      let totalDuration = 0
      let detectedLanguage: string | null = null

      for (let i = 0; i < chunkFiles.length; i++) {
        const chunkPath = path.join(tmpDir, chunkFiles[i])
        console.log(`[transcribe] ep ${episode.id} chunk ${i + 1}/${chunkFiles.length}`)

        const result = await transcribeChunk(chunkPath)
        allTexts.push(result.text)
        if (result.segments) {
          allSegments.push({ chunkIndex: i, segments: result.segments })
        }
        totalDuration += result.duration ?? CHUNK_DURATION_SECONDS
        // Use language from first chunk as the episode language
        if (i === 0 && result.language) {
          detectedLanguage = result.language
        }

        // Small delay between chunks to respect rate limits
        if (i < chunkFiles.length - 1) {
          await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS))
        }
      }

      // Stitch and apply corrections
      const rawTranscript = allTexts.join(' ')
      const correctedTranscript = applyCorrections(rawTranscript, corrections)
      const vtt = buildVtt(allSegments, corrections)

      // Store transcript — check for errors before marking episode as transcribed
      const { error: upsertError } = await supabaseAdmin.from('transcripts').upsert(
        {
          episode_id: episode.id,
          transcript: correctedTranscript,
          vtt,
          language: detectedLanguage,
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

      // Update episode status
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'transcribed', error_message: null, updated_at: new Date().toISOString() })
        .eq('id', episode.id)

      // Populate timed search cues from the VTT (best-effort — never fail the
      // episode over auxiliary search data).
      try {
        await populateCues(episode.id, vtt)
      } catch (cueErr) {
        console.warn(`[transcribe] ep ${episode.id} cue population failed:`, cueErr instanceof Error ? cueErr.message : cueErr)
      }

      // Log usage
      await logTranscriptionUsage(episode.id, totalDuration, {
        chunks: chunkFiles.length,
      })

      transcribed++
      console.log(`[transcribe] ep ${episode.id} done (${chunkFiles.length} chunks, ${Math.round(totalDuration)}s)`)
    } catch (err) {
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

  // Check if more pending episodes remain after this batch (this station only —
  // the continue-chain job carries this station's id)
  const { count: remainingCount } = await supabaseAdmin
    .from('episode_log')
    .select('id', { count: 'exact', head: true })
    .eq('station_id', stationId)
    .eq('status', 'pending')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

  const remaining = (remainingCount ?? 0) > 0
  if (remaining) {
    console.log(`[transcribe] ${remainingCount} more pending episodes — will continue`)
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
