// Deepgram provider (nova-2 prerecorded).
//
// Deepgram fetches the audio by URL itself — no ffmpeg/chunking needed, and the
// whole file is processed in one pass so diarization (speaker labels) stays
// consistent end-to-end. We always request `utterances=true` for timed segments,
// and add `diarize=true` only when diarization is enabled.

import { AudioUnavailableError } from './types'
import type {
  TranscribeContext,
  TranscriptionProvider,
  TranscriptionResult,
  NormalizedSegment,
} from './types'

const MODEL = 'nova-2'

interface DeepgramUtterance {
  start: number
  end: number
  transcript: string
  speaker?: number
}
interface DeepgramResponse {
  metadata?: { duration?: number }
  results?: {
    channels?: Array<{
      detected_language?: string
      alternatives?: Array<{ transcript?: string }>
    }>
    utterances?: DeepgramUtterance[]
  }
}

export const deepgramProvider: TranscriptionProvider = {
  id: 'deepgram',
  label: 'Deepgram (nova-2)',
  supportsDiarization: true,
  isConfigured: () => !!process.env.DEEPGRAM_API_KEY,

  async transcribe(ctx: TranscribeContext): Promise<TranscriptionResult> {
    const key = process.env.DEEPGRAM_API_KEY
    if (!key) throw new Error('DEEPGRAM_API_KEY not set')

    const qs = new URLSearchParams({
      model: MODEL,
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      detect_language: 'true',
    })
    if (ctx.diarize) qs.set('diarize', 'true')

    const response = await fetch(`https://api.deepgram.com/v1/listen?${qs.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: ctx.mp3Url }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })

    if (!response.ok) {
      const body = await response.text()
      // Deepgram returns 400/424 when it can't fetch the remote URL (gone/404).
      if (
        response.status === 400 ||
        response.status === 410 ||
        response.status === 424 ||
        /REMOTE_CONTENT_ERROR|failed to fetch|not found|404/i.test(body)
      ) {
        throw new AudioUnavailableError(`Deepgram could not fetch audio: ${response.status} ${body.slice(0, 200)}`)
      }
      throw new Error(`Deepgram API error ${response.status}: ${body.slice(0, 300)}`)
    }

    const data = (await response.json()) as DeepgramResponse
    const channel = data.results?.channels?.[0]
    const fullText = channel?.alternatives?.[0]?.transcript ?? ''
    const utterances = data.results?.utterances ?? []

    const segments: NormalizedSegment[] = utterances.map((u) => ({
      startSec: u.start,
      endSec: u.end,
      text: u.transcript,
      speaker: ctx.diarize && u.speaker != null ? `Speaker ${u.speaker}` : null,
    }))

    const diarized = ctx.diarize && segments.some((s) => s.speaker)

    return {
      text: fullText || segments.map((s) => s.text).join(' '),
      segments,
      durationSec: data.metadata?.duration ?? 0,
      language: channel?.detected_language ?? null,
      providerId: 'deepgram',
      model: MODEL,
      diarized,
    }
  },
}
