// Groq Batch API client for transcription (https://console.groq.com/docs/batch).
//
// Flow: build a JSONL file (one /v1/audio/transcriptions request per episode,
// audio passed by URL — Groq fetches the archive MP3 itself, no ffmpeg) →
// upload it (Files API, purpose=batch) → create the batch → poll → download the
// output (and error) file → map each line back to its episode by custom_id.
// Billed at 50% of the synchronous rate. Same Whisper output as the sync path
// (verbose_json + segment timestamps), so the result feeds the same store/VTT code.

import type { NormalizedSegment, TranscriptionResult } from './types'
import { dropPromptEchoSegments } from './vocabulary'

const GROQ_BASE = 'https://api.groq.com/openai/v1'
export const BATCH_COMPLETION_WINDOW = '24h'

const CUSTOM_ID_PREFIX = 'ep-'
export const customIdFor = (episodeId: number) => `${CUSTOM_ID_PREFIX}${episodeId}`
export function episodeIdFromCustomId(customId: unknown): number | null {
  if (typeof customId !== 'string' || !customId.startsWith(CUSTOM_ID_PREFIX)) return null
  const n = Number(customId.slice(CUSTOM_ID_PREFIX.length))
  return Number.isInteger(n) && n > 0 ? n : null
}

export interface BatchRequestInput {
  episodeId: number
  mp3Url: string
  prompt?: string
}

/** One JSONL request line per episode. Pure. */
export function buildBatchJsonl(items: BatchRequestInput[], model: string): string {
  return items
    .map((it) =>
      JSON.stringify({
        custom_id: customIdFor(it.episodeId),
        method: 'POST',
        url: '/v1/audio/transcriptions',
        body: {
          model,
          url: it.mp3Url,
          response_format: 'verbose_json',
          timestamp_granularities: ['segment'],
          ...(it.prompt ? { prompt: it.prompt } : {}),
        },
      }),
    )
    .join('\n') + '\n'
}

interface WhisperResponse {
  text?: string
  segments?: { start: number; end: number; text: string }[]
  duration?: number
  language?: string
}

export type BatchLineResult =
  | { episodeId: number; ok: true; whisper: WhisperResponse }
  | { episodeId: number; ok: false; error: string }

/**
 * Parse an output or error JSONL file. Each line is
 * `{custom_id, response: {status_code, body}, error}`. Lines whose custom_id
 * isn't ours are ignored. Pure.
 */
export function parseBatchOutput(jsonl: string): BatchLineResult[] {
  const out: BatchLineResult[] = []
  for (const raw of jsonl.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let row: Record<string, any>
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const episodeId = episodeIdFromCustomId(row.custom_id)
    if (episodeId == null) continue
    const status = row.response?.status_code
    const body = row.response?.body
    if (status === 200 && body && typeof body.text === 'string') {
      out.push({ episodeId, ok: true, whisper: body })
    } else {
      const msg =
        row.error?.message ??
        body?.error?.message ??
        (status ? `HTTP ${status}` : 'no response')
      out.push({ episodeId, ok: false, error: `Groq batch: ${String(msg).slice(0, 500)}` })
    }
  }
  return out
}

/**
 * A batch Whisper response → the provider-neutral result the store path takes.
 * Whole file in one request, so no chunk offsets. A prompted request can read
 * its name list back as speech — drop those segments, same as the sync path. Pure.
 */
export function whisperToResult(
  w: WhisperResponse,
  model: string,
  prompt?: string,
  promptStationTerms?: string[],
): TranscriptionResult {
  let segments: NormalizedSegment[] = (w.segments ?? []).map((s) => ({
    startSec: s.start,
    endSec: s.end,
    text: s.text,
  }))
  let text = w.text ?? ''
  if (prompt) {
    const kept = dropPromptEchoSegments(segments, prompt, promptStationTerms)
    if (kept.length !== segments.length) {
      segments = kept
      text = kept.map((s) => s.text.trim()).filter(Boolean).join(' ')
    }
  }
  const lastEnd = segments.length ? segments[segments.length - 1].endSec : 0
  return {
    text,
    segments,
    durationSec: typeof w.duration === 'number' && w.duration > 0 ? w.duration : lastEnd,
    language: w.language ?? null,
    providerId: 'groq',
    model,
    diarized: false,
  }
}

// ---------------------------------------------------------------------------
// HTTP (not unit-tested; thin wrappers with timeouts — nothing here may hang)
// ---------------------------------------------------------------------------

function apiKey(): string {
  const k = process.env.GROQ_API_KEY
  if (!k) throw new Error('GROQ_API_KEY not set')
  return k
}

async function groqJson(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GROQ_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(2 * 60_000),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`Groq ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 300)}`)
  return body ? JSON.parse(body) : {}
}

export async function uploadBatchFile(jsonl: string, filename: string): Promise<string> {
  const form = new FormData()
  form.append('purpose', 'batch')
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), filename)
  const r = await groqJson('/files', { method: 'POST', body: form })
  if (!r.id) throw new Error('Groq file upload returned no id')
  return r.id as string
}

export async function createBatch(inputFileId: string, metadata?: Record<string, string>): Promise<{ id: string; status: string }> {
  const r = await groqJson('/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: '/v1/audio/transcriptions',
      completion_window: BATCH_COMPLETION_WINDOW,
      ...(metadata ? { metadata } : {}),
    }),
  })
  if (!r.id) throw new Error('Groq batch create returned no id')
  return { id: r.id, status: r.status }
}

export interface GroqBatchStatus {
  id: string
  /** validating | in_progress | finalizing | completed | failed | expired | cancelling | cancelled */
  status: string
  output_file_id?: string | null
  error_file_id?: string | null
  errors?: unknown
}

export async function getBatch(batchId: string): Promise<GroqBatchStatus> {
  return groqJson(`/batches/${encodeURIComponent(batchId)}`)
}

export async function downloadFile(fileId: string): Promise<string> {
  const res = await fetch(`${GROQ_BASE}/files/${encodeURIComponent(fileId)}/content`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(5 * 60_000),
  })
  if (!res.ok) throw new Error(`Groq file download ${fileId} → ${res.status}`)
  return res.text()
}

/** Groq statuses after which a batch will never change again. */
export const TERMINAL_BATCH_STATUSES = ['completed', 'failed', 'expired', 'cancelled'] as const
export function isTerminalBatchStatus(s: string): boolean {
  return (TERMINAL_BATCH_STATUSES as readonly string[]).includes(s)
}

/** HEAD an archive MP3 for its size (bytes), or null if unknown. Never throws. */
export async function probeContentLength(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return null
    const n = Number(res.headers.get('content-length'))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}
