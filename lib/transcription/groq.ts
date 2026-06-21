// Groq Whisper provider (whisper-large-v3).
//
// Groq has a 25MB / short-context limit, so audio is chunked into 15-min M4A
// segments by the worker (ffmpeg) and each chunk is sent separately. Groq does
// NOT diarize — segments carry timestamps but no speaker labels.

import * as fs from 'fs/promises'
import * as path from 'path'
import type {
  TranscribeContext,
  TranscriptionProvider,
  TranscriptionResult,
  NormalizedSegment,
} from './types'

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
const MODEL = 'whisper-large-v3'
const INTER_CHUNK_DELAY_MS = 1500

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

async function transcribeChunk(chunkPath: string): Promise<WhisperResponse> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('GROQ_API_KEY not set')

  const fileData = await fs.readFile(chunkPath)
  const formData = new FormData()
  formData.append('file', new Blob([fileData]), path.basename(chunkPath))
  formData.append('model', MODEL)
  formData.append('response_format', 'verbose_json')

  let lastError: Error | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}` },
      body: formData,
      signal: AbortSignal.timeout(5 * 60 * 1000),
    })

    if (response.ok) return (await response.json()) as WhisperResponse

    if (response.status === 429) {
      const delay = Math.pow(2, attempt + 1) * 1000
      console.warn(`[transcribe:groq] rate limited, retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
      lastError = new Error(`Groq rate limit (429) after ${attempt + 1} attempts`)
      continue
    }

    const body = await response.text()
    throw new Error(`Groq API error ${response.status}: ${body}`)
  }

  throw lastError ?? new Error('Groq API failed after retries')
}

export const groqProvider: TranscriptionProvider = {
  id: 'groq',
  label: 'Groq Whisper',
  supportsDiarization: false,
  isConfigured: () => !!process.env.GROQ_API_KEY,

  async transcribe(ctx: TranscribeContext): Promise<TranscriptionResult> {
    const chunkPaths = await ctx.getLocalChunks()
    if (!chunkPaths.length) throw new Error('Groq: no audio chunks to transcribe')

    const texts: string[] = []
    const segments: NormalizedSegment[] = []
    let durationSec = 0
    let language: string | null = null

    for (let i = 0; i < chunkPaths.length; i++) {
      console.log(`[transcribe:groq] ep ${ctx.episodeId} chunk ${i + 1}/${chunkPaths.length}`)
      const result = await transcribeChunk(chunkPaths[i])
      texts.push(result.text)
      const offset = i * ctx.chunkDurationSec
      for (const seg of result.segments ?? []) {
        segments.push({ startSec: seg.start + offset, endSec: seg.end + offset, text: seg.text })
      }
      durationSec += result.duration ?? ctx.chunkDurationSec
      if (i === 0 && result.language) language = result.language
      if (i < chunkPaths.length - 1) {
        await new Promise((r) => setTimeout(r, INTER_CHUNK_DELAY_MS))
      }
    }

    return {
      text: texts.join(' '),
      segments,
      durationSec,
      language,
      providerId: 'groq',
      model: MODEL,
      diarized: false,
    }
  },
}
