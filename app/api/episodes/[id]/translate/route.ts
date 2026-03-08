import { NextRequest, NextResponse } from 'next/server'
import OpenAI from 'openai'
import { supabaseAdmin } from '@/lib/supabase'

const OPENAI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const episodeId = parseInt(params.id)
    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) {
      return NextResponse.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 })
    }

    // Fetch transcript
    const { data: transcript, error } = await supabaseAdmin
      .from('transcripts')
      .select('*')
      .eq('episode_id', episodeId)
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

    // Translate the full transcript
    const transcriptResponse = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a professional translator. Translate the following text from Spanish to English. Preserve paragraph breaks. Output ONLY the translated text, nothing else.',
        },
        { role: 'user', content: transcript.transcript },
      ],
      temperature: 0.3,
    })

    const englishTranscript = transcriptResponse.choices[0]?.message?.content
    if (!englishTranscript) {
      return NextResponse.json({ error: 'Translation failed — empty response' }, { status: 500 })
    }

    // Translate VTT cues if available
    let englishVtt: string | null = null
    let vttUsage: { prompt_tokens: number; completion_tokens: number } | null = null

    if (transcript.vtt) {
      // Extract cue texts from VTT, translate in batches, and rebuild
      const cueLines = extractVttCueTexts(transcript.vtt)

      if (cueLines.length > 0) {
        // Batch cue texts into chunks of ~100 to stay within context limits
        const batchSize = 100
        const translatedCues: string[] = []

        for (let i = 0; i < cueLines.length; i += batchSize) {
          const batch = cueLines.slice(i, i + batchSize)
          const numbered = batch.map((text, idx) => `[${i + idx}] ${text}`).join('\n')

          const vttResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: 'Translate each numbered line from Spanish to English. Keep the [N] numbering prefix on each line. Output ONLY the translated numbered lines, nothing else.',
              },
              { role: 'user', content: numbered },
            ],
            temperature: 0.3,
          })

          const translated = vttResponse.choices[0]?.message?.content ?? ''
          // Parse out the numbered translations
          const lines = translated.split('\n').filter((l) => l.trim())
          for (const line of lines) {
            const match = line.match(/^\[(\d+)\]\s*(.*)/)
            if (match) {
              translatedCues[parseInt(match[1])] = match[2]
            }
          }

          if (vttResponse.usage) {
            if (!vttUsage) {
              vttUsage = { prompt_tokens: 0, completion_tokens: 0 }
            }
            vttUsage.prompt_tokens += vttResponse.usage.prompt_tokens
            vttUsage.completion_tokens += vttResponse.usage.completion_tokens
          }
        }

        // Rebuild VTT with translated cue texts
        englishVtt = rebuildVttWithTranslations(transcript.vtt, translatedCues)
      }
    }

    // Store translations
    await supabaseAdmin
      .from('transcripts')
      .update({
        english_transcript: englishTranscript,
        english_vtt: englishVtt,
      })
      .eq('episode_id', episodeId)

    // Log usage
    const transcriptUsage = transcriptResponse.usage
    const totalInput = (transcriptUsage?.prompt_tokens ?? 0) + (vttUsage?.prompt_tokens ?? 0)
    const totalOutput = (transcriptUsage?.completion_tokens ?? 0) + (vttUsage?.completion_tokens ?? 0)

    if (totalInput > 0) {
      const estimatedCost =
        totalInput * OPENAI_INPUT_COST_PER_TOKEN +
        totalOutput * OPENAI_OUTPUT_COST_PER_TOKEN

      await supabaseAdmin.from('usage_log').insert({
        episode_id: episodeId,
        service: 'openai',
        model: 'gpt-4o-mini',
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
