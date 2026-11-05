// Groq Whisper provider (model per station: lib/groq-models.ts, default turbo).
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
import { resolveGroqModel } from '../groq-models'
import { dropPromptEchoSegments } from './vocabulary'

const GROQ_API_URL = 'https://api.groq.com/openai/v1/audio/transcriptions'
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

// Groq rejects an oversized/invalid prompt with a 400 rather than trimming it.
// That must cost us the hint, never the transcript (a throw here would fail the
// whole Groq attempt over to the next provider).
class PromptRejectedError extends Error {}

async function transcribeChunk(chunkPath: string, model: string, prompt?: string): Promise<WhisperResponse> {
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('GROQ_API_KEY not set')

  const fileData = await fs.readFile(chunkPath)
  const formData = new FormData()
  formData.append('file', new Blob([fileData]), path.basename(chunkPath))
  formData.append('model', model)
  formData.append('response_format', 'verbose_json')
  if (prompt) formData.append('prompt', prompt)

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
    if (prompt && response.status === 400 && /prompt/i.test(body)) {
      throw new PromptRejectedError(`Groq rejected the vocabulary prompt: ${body.slice(0, 200)}`)
    }
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
    const model = resolveGroqModel(ctx.model)
    const chunkPaths = await ctx.getLocalChunks()
    if (!chunkPaths.length) throw new Error('Groq: no audio chunks to transcribe')

    const texts: string[] = []
    const segments: NormalizedSegment[] = []
    let durationSec = 0
    let language: string | null = null

    for (let i = 0; i < chunkPaths.length; i++) {
      console.log(`[transcribe:groq] ep ${ctx.episodeId} chunk ${i + 1}/${chunkPaths.length}`)
      let result: WhisperResponse
      let promptUsed = !!ctx.prompt
      try {
        result = await transcribeChunk(chunkPaths[i], model, ctx.prompt)
      } catch (err) {
        if (!(err instanceof PromptRejectedError)) throw err
        console.warn(`[transcribe:groq] ep ${ctx.episodeId} ${err.message} — retrying chunk without it`)
        promptUsed = false
        result = await transcribeChunk(chunkPaths[i], model)
      }
      const offset = i * ctx.chunkDurationSec
      let chunkSegments: NormalizedSegment[] = (result.segments ?? []).map((seg) => ({
        startSec: seg.start + offset,
        endSec: seg.end + offset,
        text: seg.text,
      }))
      if (promptUsed && ctx.prompt) {
        // A prompted run can read the name list back as if spoken — drop it.
        const kept = dropPromptEchoSegments(chunkSegments, ctx.prompt, ctx.promptStationTerms)
        if (kept.length !== chunkSegments.length) {
          console.log(`[transcribe:groq] ep ${ctx.episodeId} chunk ${i + 1}: dropped ${chunkSegments.length - kept.length} prompt-echo segment(s)`)
          chunkSegments = kept
          texts.push(kept.map((sg) => sg.text.trim()).filter(Boolean).join(' '))
        } else {
          texts.push(result.text)
        }
      } else {
        texts.push(result.text)
      }
      segments.push(...chunkSegments)
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
      model,
      diarized: false,
    }
  },
}
