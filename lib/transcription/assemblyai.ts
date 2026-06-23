// AssemblyAI provider (Universal/best, async transcription).
//
// AssemblyAI fetches the audio by URL itself (no chunking) and returns
// utterance-level segments. Diarization is `speaker_labels: true`. The async API
// is submit-then-poll: POST a job, then GET until status is completed/error.

import { AudioUnavailableError } from './types'
import type {
  TranscribeContext,
  TranscriptionProvider,
  TranscriptionResult,
  NormalizedSegment,
} from './types'

const BASE = 'https://api.assemblyai.com/v2/transcript'
const MODEL = 'universal'
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 15 * 60 * 1000

interface AaiUtterance {
  start: number // ms
  end: number // ms
  text: string
  speaker?: string
}
interface AaiTranscript {
  id: string
  status: 'queued' | 'processing' | 'completed' | 'error'
  text?: string
  audio_duration?: number // seconds
  language_code?: string
  utterances?: AaiUtterance[]
  error?: string
}

export const assemblyaiProvider: TranscriptionProvider = {
  id: 'assemblyai',
  label: 'AssemblyAI',
  supportsDiarization: true,
  isConfigured: () => !!process.env.ASSEMBLYAI_API_KEY,

  async transcribe(ctx: TranscribeContext): Promise<TranscriptionResult> {
    const key = process.env.ASSEMBLYAI_API_KEY
    if (!key) throw new Error('ASSEMBLYAI_API_KEY not set')
    const headers = { Authorization: key, 'Content-Type': 'application/json' }

    // Submit the job.
    const submit = await fetch(BASE, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        audio_url: ctx.mp3Url,
        speaker_labels: ctx.diarize,
        language_detection: true,
      }),
      signal: AbortSignal.timeout(60 * 1000),
    })
    if (!submit.ok) {
      const body = await submit.text()
      throw new Error(`AssemblyAI submit error ${submit.status}: ${body.slice(0, 300)}`)
    }
    const job = (await submit.json()) as AaiTranscript
    if (!job.id) throw new Error('AssemblyAI: no transcript id returned')

    // Poll until terminal.
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let result: AaiTranscript = job
    while (result.status !== 'completed' && result.status !== 'error') {
      if (Date.now() > deadline) throw new Error('AssemblyAI: polling timed out')
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const poll = await fetch(`${BASE}/${job.id}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(60 * 1000),
      })
      if (!poll.ok) {
        const body = await poll.text()
        throw new Error(`AssemblyAI poll error ${poll.status}: ${body.slice(0, 300)}`)
      }
      result = (await poll.json()) as AaiTranscript
    }

    if (result.status === 'error') {
      const msg = result.error ?? 'unknown error'
      // A download failure means the source MP3 is gone — terminal.
      if (/download|fetch|not found|404|unreachable|does not exist/i.test(msg)) {
        throw new AudioUnavailableError(`AssemblyAI could not fetch audio: ${msg}`)
      }
      throw new Error(`AssemblyAI transcription failed: ${msg}`)
    }

    const utterances = result.utterances ?? []
    // Times are milliseconds → seconds.
    const segments: NormalizedSegment[] = utterances.map((u) => ({
      startSec: u.start / 1000,
      endSec: u.end / 1000,
      text: u.text,
      speaker: ctx.diarize && u.speaker != null ? `Speaker ${u.speaker}` : null,
    }))

    const diarized = ctx.diarize && segments.some((s) => s.speaker)

    return {
      text: result.text ?? segments.map((s) => s.text).join(' '),
      segments,
      durationSec: result.audio_duration ?? 0,
      language: result.language_code ?? null,
      providerId: 'assemblyai',
      model: MODEL,
      diarized,
    }
  },
}
