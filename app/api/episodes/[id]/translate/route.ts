import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getStationContext, stationErrorResponse } from '@/lib/auth'

export const dynamic = 'force-dynamic'
// Translating a full hour-long episode is many model calls; allow headroom
// before the platform kills the request (the work is also cached after one run).
export const maxDuration = 300

const OPENAI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000

const TRANSLATE_MODEL = 'gpt-4o-mini'
// Parallel model calls per request. The previous version did the whole VTT
// sequentially (an hour episode took ~7 min); fanning out the transcript chunks
// and cue batches brings that under a minute for the same ~2¢ cost.
const CONCURRENCY = 6
const TRANSCRIPT_CHUNK_CHARS = 3500
const VTT_BATCH_SIZE = 100

type Usage = { prompt_tokens: number; completion_tokens: number }

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const episodeId = parseInt(params.id)
    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
    }

    // Fetch transcript, scoped to this station via the episode_log join
    // (transcripts has no station_id of its own).
    const { data: transcript, error } = await supabase
      .from('transcripts')
      .select('*, episode_log!inner(station_id)')
      .eq('episode_id', episodeId)
      .eq('episode_log.station_id', stationId)
      .single()

    if (error || !transcript) {
      return NextResponse.json({ error: 'Transcript not found' }, { status: 404 })
    }

    // If already translated, return cached result
    if (transcript.english_transcript) {
      return NextResponse.json({
        english_transcript: transcript.english_transcript,
        english_vtt: transcript.english_vtt,
        cached: true,
      })
    }

    if (!transcript.transcript) {
      return NextResponse.json({ error: 'No transcript text to translate' }, { status: 400 })
    }

    const openai = new OpenAI({ apiKey: openaiKey })
    const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 }

    // --- Transcript: split into paragraph-aligned chunks, translate in parallel ---
    const chunks = chunkByParagraph(transcript.transcript, TRANSCRIPT_CHUNK_CHARS)
    const translatedChunks = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
      const resp = await withRetry(() =>
        openai.chat.completions.create({
          model: TRANSLATE_MODEL,
          messages: [
            {
              role: 'system',
              content:
                'You are a professional translator. Detect the language of the following text and translate it into English. If it is already English, return it unchanged. Preserve paragraph breaks. Output ONLY the translated text, nothing else.',
            },
            { role: 'user', content: chunk },
          ],
          temperature: 0.3,
        })
      )
      accumulate(usage, resp.usage)
      return resp.choices[0]?.message?.content ?? ''
    })

    const englishTranscript = translatedChunks.join('\n\n').trim()
    if (!englishTranscript) {
      return NextResponse.json({ error: 'Translation failed — empty response' }, { status: 500 })
    }

    // --- VTT cues: translate batches of 100 in parallel, then rebuild ---
    let englishVtt: string | null = null
    if (transcript.vtt) {
      const cueLines = extractVttCueTexts(transcript.vtt)
      if (cueLines.length > 0) {
        const batchStarts: number[] = []
        for (let i = 0; i < cueLines.length; i += VTT_BATCH_SIZE) batchStarts.push(i)
        const translatedCues: string[] = new Array(cueLines.length)

        await mapLimit(batchStarts, CONCURRENCY, async (start) => {
          const batch = cueLines.slice(start, start + VTT_BATCH_SIZE)
          const numbered = batch.map((text, idx) => `[${start + idx}] ${text}`).join('\n')
          const resp = await withRetry(() =>
            openai.chat.completions.create({
              model: TRANSLATE_MODEL,
              messages: [
                {
                  role: 'system',
                  content:
                    'Translate each numbered line into English (detect the source language; leave English lines unchanged). Keep the [N] numbering prefix on each line. Output ONLY the translated numbered lines, nothing else.',
                },
                { role: 'user', content: numbered },
              ],
              temperature: 0.3,
            })
          )
          accumulate(usage, resp.usage)
          const translated = resp.choices[0]?.message?.content ?? ''
          for (const line of translated.split('\n')) {
            const match = line.match(/^\[(\d+)\]\s*(.*)/)
            if (match) translatedCues[parseInt(match[1], 10)] = match[2]
          }
        })

        englishVtt = rebuildVttWithTranslations(transcript.vtt, translatedCues)
      }
    }

    // Store translations
    await supabase
      .from('transcripts')
      .update({
        english_transcript: englishTranscript,
        english_vtt: englishVtt,
      })
      .eq('episode_id', episodeId)

    // Log usage (single row for the whole translation)
    const totalInput = usage.prompt_tokens
    const totalOutput = usage.completion_tokens
    if (totalInput > 0) {
      const estimatedCost =
        totalInput * OPENAI_INPUT_COST_PER_TOKEN + totalOutput * OPENAI_OUTPUT_COST_PER_TOKEN
      await supabase.from('usage_log').insert({
        station_id: stationId,
        episode_id: episodeId,
        service: 'openai',
        model: TRANSLATE_MODEL,
        operation: 'summarize', // reuse existing operation type for cost tracking
        input_tokens: totalInput,
        output_tokens: totalOutput,
        duration_seconds: null,
        estimated_cost: estimatedCost,
        metadata: { task: 'translate', language: transcript.language ?? 'es' },
      })
    }

    return NextResponse.json({
      english_transcript: englishTranscript,
      english_vtt: englishVtt,
      cached: false,
    })
  } catch (err) {
    console.error('POST /api/episodes/[id]/translate failed:', err)
    return NextResponse.json({ error: 'Translation failed' }, { status: 500 })
  }
}

/** Add a chat-completion's token usage into the running total. */
function accumulate(into: Usage, u?: { prompt_tokens?: number; completion_tokens?: number } | null) {
  if (!u) return
  into.prompt_tokens += u.prompt_tokens ?? 0
  into.completion_tokens += u.completion_tokens ?? 0
}

/** Retry transient failures (429 rate limits, 5xx) with exponential backoff.
 *  Non-retryable client errors (4xx other than 429) throw immediately. */
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number })?.status
      if (status && status !== 429 && status < 500) throw err
      if (attempt === retries) break
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    }
  }
  throw lastErr
}

/** Run `fn` over `items` with at most `limit` in flight at once, preserving
 *  result order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    for (;;) {
      const idx = next++
      if (idx >= items.length) return
      results[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, () => worker()))
  return results
}

/** Split text into chunks no larger than ~maxChars, breaking only on paragraph
 *  boundaries so a chunk never cuts mid-sentence. */
function chunkByParagraph(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > maxChars) {
      chunks.push(current)
      current = ''
    }
    current = current ? `${current}\n\n${p}` : p
  }
  if (current) chunks.push(current)
  return chunks.length ? chunks : [text]
}

/** Extract just the text content from each VTT cue */
function extractVttCueTexts(vtt: string): string[] {
  const texts: string[] = []
  const blocks = vtt.split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        const text = lines.slice(i + 1).join(' ').trim()
        if (text) texts.push(text)
      }
    }
  }
  return texts
}

/** Rebuild VTT, replacing cue texts with translations */
function rebuildVttWithTranslations(vtt: string, translations: string[]): string {
  const blocks = vtt.split(/\n\n+/)
  const result: string[] = []
  let cueIndex = 0

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    let hasTimestamp = false

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        hasTimestamp = true
        // Rebuild this cue block with translated text
        const headerLines = lines.slice(0, i + 1)
        const translated = translations[cueIndex] ?? lines.slice(i + 1).join(' ').trim()
        result.push([...headerLines, translated].join('\n'))
        cueIndex++
        break
      }
    }

    if (!hasTimestamp) {
      result.push(block.trim()) // WEBVTT header or other non-cue blocks
    }
  }

  return result.join('\n\n') + '\n'
}
