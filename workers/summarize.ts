import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logSummarizationUsage } from '../lib/usage'
import { getExcludedCategories, getSummarizeBatchSize } from '../lib/settings'

const SYSTEM_PROMPT = `You are an expert public radio producer for KPFK.
Your task is to produce an internal archival log of a radio broadcast based on a transcript, and to flag any clear conflicts with provided metadata.
This is NOT a program description or promotional summary.
INPUTS:
- Episode metadata (may include show title, air date/time, listed host(s), listed guest(s))
- A transcript of the broadcast
GENERAL RULES:
- Be concise, neutral, and factual.
- Do NOT add opinions, analysis, praise, criticism, political framing, or moral judgment.
- Do NOT explain why topics matter.
- Do NOT describe significance, impact, importance, implications, or future outcomes.
- Do NOT narrate structure, flow, or progression.
- Never invent names, roles, relationships, motivations, or conclusions.
- If something is unclear or not explicitly stated, leave it blank.
LANGUAGE RULES:
- Do NOT use: "In this episode", "This episode", "The show", "The program", "This broadcast".
- Do NOT describe beginnings, endings, transitions, or conclusions.
- Do NOT use verbs such as: "highlights", "emphasizes", "underscores", "examines", "explores", "addresses", "reflects", "focuses on", "concludes", "reviews".
- Use only neutral, descriptive verbs such as: "discusses", "describes", "outlines", "explains", "states", "argues".
- Prefer speaker-led or topic-led sentences.
- When a claim or opinion appears, attribute it to the speaker.
DISCREPANCY RULE:
- Compare metadata with what is explicitly stated in the transcript.
- If there is a clear conflict, write a short factual note in "discrepancy".
- Do NOT guess, infer, resolve, or explain conflicts.
- If there is no clear conflict, leave "discrepancy" blank.
CONTENT REQUIREMENTS:
HEADLINE: One short declarative sentence listing main subjects. No dates, adjectives, or conclusions.
SUMMARY: 4-8 sentences. Each states a topic or speaker statement. No structure descriptions. Under 900 characters.
HOST: Name(s) only if explicitly stated in transcript. Comma-separated if multiple. Blank if unclear.
GUEST: Name(s) only if explicitly introduced. Comma-separated if multiple. Blank if none/unclear.
ISSUE_CATEGORY: One of: Civil Rights / Social Justice, Immigration, Economy / Labor, Environment / Climate, Government / Politics, Health, International Affairs / War & Peace, Arts & Culture.
OUTPUT: Return ONLY valid JSON. No markdown, no extra text.
{"headline":"string","summary":"string","host":"string","guest":"string","discrepancy":"string","issue_category":"string"}`

interface SummaryResponse {
  headline: string
  summary: string
  host: string
  guest: string
  discrepancy: string
  issue_category: string
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

export async function processSummarize(job: Job) {
  console.log('[summarize] starting batch...')

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set')

  const openai = new OpenAI({ apiKey: openaiKey })
  const excludedCategories = await getExcludedCategories()
  const batchSize = await getSummarizeBatchSize()
  const { start, end } = getCurrentQuarterBounds()

  // Get transcribed episodes from current quarter
  const { data: episodes, error } = await supabaseAdmin
    .from('episode_log')
    .select('*')
    .eq('status', 'transcribed')
    .gte('air_date', start)
    .lte('air_date', end)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!episodes?.length) {
    console.log('[summarize] no transcribed episodes')
    return { summarized: 0 }
  }

  const filteredEpisodes = episodes.filter(
    (ep) => !excludedCategories.some((exc) => ep.category?.includes(exc))
  )

  let summarized = 0

  for (const episode of filteredEpisodes) {
    try {
      // Load transcript
      const { data: transcript } = await supabaseAdmin
        .from('transcripts')
        .select('transcript')
        .eq('episode_id', episode.id)
        .single()

      if (!transcript?.transcript) {
        console.warn(`[summarize] no transcript for episode ${episode.id}`)
        continue
      }

      const userMessage = `Show: ${episode.show_name || ''}
Host(s): ${episode.host || ''}
Guest(s): ${episode.guest || ''}
Transcript:
${transcript.transcript}`

      // Retry with exponential backoff on transient errors
      let response: OpenAI.Chat.Completions.ChatCompletion | null = null
      let lastError: Error | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.3,
            response_format: { type: 'json_object' },
          })
          break
        } catch (err: unknown) {
          lastError = err instanceof Error ? err : new Error(String(err))
          const status = (err as { status?: number })?.status
          if (status && [429, 500, 502, 503].includes(status)) {
            const delay = Math.pow(2, attempt + 1) * 1000
            console.warn(`[summarize] ep ${episode.id} OpenAI error ${status}, retrying in ${delay}ms...`)
            await new Promise((r) => setTimeout(r, delay))
            continue
          }
          throw err
        }
      }

      if (!response) throw lastError ?? new Error('OpenAI failed after retries')

      const content = response.choices[0]?.message?.content
      if (!content) throw new Error('Empty response from OpenAI')

      let parsed: SummaryResponse
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error(`Invalid JSON from OpenAI: ${content.slice(0, 200)}`)
      }

      // Update episode with summary data
      await supabaseAdmin
        .from('episode_log')
        .update({
          headline: parsed.headline || null,
          summary: parsed.summary || null,
          host: parsed.host || episode.host || null,
          guest: parsed.guest || null,
          issue_category: parsed.issue_category || null,
          compliance_report: parsed.discrepancy || null,
          status: 'summarized',
          error_message: null,
        })
        .eq('id', episode.id)

      // Log usage
      const usage = response.usage
      if (usage) {
        await logSummarizationUsage(
          episode.id,
          usage.prompt_tokens,
          usage.completion_tokens
        )
      }

      summarized++
      console.log(`[summarize] ep ${episode.id} done: "${parsed.headline?.slice(0, 60)}"`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[summarize] ep ${episode.id} failed:`, errMsg)
      await supabaseAdmin
        .from('episode_log')
        .update({
          status: 'failed',
          error_message: errMsg.slice(0, 1000),
          retry_count: (episode.retry_count ?? 0) + 1,
        })
        .eq('id', episode.id)
    }
  }

  return { summarized }
}
