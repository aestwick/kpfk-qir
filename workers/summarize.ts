import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logSummarizationUsage } from '../lib/usage'
import { getExcludedCategories, getSummarizeBatchSize, getSummarizationPrompt, isPipelinePaused } from '../lib/settings'

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
  if (await isPipelinePaused()) {
    console.log('[summarize] pipeline paused — skipping')
    return { summarized: 0, remaining: false, skipped: true }
  }
  console.log('[summarize] starting batch...')

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set')

  const openai = new OpenAI({ apiKey: openaiKey, timeout: 5 * 60 * 1000 })
  const excludedCategories = await getExcludedCategories()
  const batchSize = await getSummarizeBatchSize()
  const systemPrompt = await getSummarizationPrompt()
  const { start, end } = getCurrentQuarterBounds()

  // Get transcribed episodes from current quarter (including those with null air_date
  // that were created during this quarter — older ingests didn't populate air_date)
  const { data: episodes, error } = await supabaseAdmin
    .from('episode_log')
    .select('*')
    .eq('status', 'transcribed')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
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

  // Batch-fetch all transcripts upfront to avoid N+1 queries
  const epIds = filteredEpisodes.map((ep) => ep.id)
  const { data: transcriptsData } = await supabaseAdmin
    .from('transcripts')
    .select('episode_id, transcript')
    .in('episode_id', epIds)

  const transcriptMap = new Map(
    (transcriptsData ?? []).map((t) => [t.episode_id, t.transcript])
  )

  let summarized = 0

  for (let i = 0; i < filteredEpisodes.length; i++) {
    const episode = filteredEpisodes[i]
    await job.updateProgress({ current: i + 1, total: filteredEpisodes.length, episodeId: episode.id, showName: episode.show_name || episode.show_key, airDate: episode.air_date })
    try {
      const transcriptText = transcriptMap.get(episode.id)

      if (!transcriptText) {
        console.warn(`[summarize] no transcript for episode ${episode.id}, marking as transcript_missing`)
        await supabaseAdmin
          .from('episode_log')
          .update({
            status: 'transcript_missing',
            error_message: 'Episode marked as transcribed but no transcript found in database',
            updated_at: new Date().toISOString(),
          })
          .eq('id', episode.id)
        continue
      }

      const userMessage = `Show: ${episode.show_name || ''}
Air Date: ${episode.air_date || ''}
Time: ${episode.air_time || ''}
Host(s): ${episode.host || ''}
Guest(s): ${episode.guest || ''}
Transcript:
${transcriptText}`

      // Retry with exponential backoff on transient errors
      let response: OpenAI.Chat.Completions.ChatCompletion | null = null
      let lastError: Error | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
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

      if (!parsed.headline || !parsed.summary) {
        throw new Error(`OpenAI returned incomplete summary (missing headline or summary): ${content.slice(0, 200)}`)
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
          updated_at: new Date().toISOString(),
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
          updated_at: new Date().toISOString(),
        })
        .eq('id', episode.id)
    }
  }

  // Check if more transcribed episodes remain after this batch
  const { count: remainingCount } = await supabaseAdmin
    .from('episode_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'transcribed')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

  const remaining = (remainingCount ?? 0) > 0
  if (remaining) {
    console.log(`[summarize] ${remainingCount} more transcribed episodes — will continue`)
  }

  return { summarized, remaining }
}
