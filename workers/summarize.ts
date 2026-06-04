import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { logSummarizationUsage, logEmbeddingUsage } from '../lib/usage'
import { getExcludedCategories, getSummarizeBatchSize, getSummarizationPrompt, isPipelinePaused, isEmbeddingsEnabled, getEmbeddingModel } from '../lib/settings'
import { isSpendLimitError } from '../lib/retry-policy'
import { buildEpisodeChunkRows, storeEpisodeChunks } from '../lib/transcript-embeddings'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { getCurrentQuarterBounds } from '../lib/quarters'

interface SummaryResponse {
  headline: string
  summary: string
  host: string
  guest: string
  discrepancy: string
  issue_category: string
}

export async function processSummarize(job: Job) {
  // Service-role client bypasses RLS, so the station_id filter is the only guard.
  const stationId = job.data?.stationId as string | undefined
  if (!stationId) throw new Error('[summarize] stationId is required in job data')
  // Skip if the pipeline is paused globally OR just for this station.
  if (await isPipelinePaused(stationId)) {
    console.log(`[summarize] paused for station ${stationId} — skipping`)
    return { summarized: 0, remaining: false, skipped: true }
  }
  console.log('[summarize] starting batch...')

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) throw new Error('OPENAI_API_KEY not set')

  const openai = new OpenAI({ apiKey: openaiKey, timeout: 5 * 60 * 1000 })
  const excludedCategories = await getExcludedCategories(stationId)
  const batchSize = await getSummarizeBatchSize(stationId)
  const systemPrompt = await getSummarizationPrompt(stationId)
  // Phase 2 semantic search: embed each episode's transcript right after the
  // summary (resolved once per batch — the 60s settings cache makes this cheap).
  const embeddingsEnabled = await isEmbeddingsEnabled(stationId)
  const embeddingModel = await getEmbeddingModel(stationId)
  const { start, end } = getCurrentQuarterBounds()

  // Get candidate transcribed episodes from current quarter (including those with null
  // air_date that were created during this quarter — older ingests didn't populate it)
  const { data: candidates, error } = await supabaseAdmin
    .from('episode_log')
    .select('id, category')
    .eq('station_id', stationId)
    .eq('status', 'transcribed')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!candidates?.length) {
    console.log('[summarize] no transcribed episodes')
    return { summarized: 0 }
  }

  // Drop excluded categories before claiming so they stay transcribed (not stuck mid-stage)
  const claimIds = candidates
    .filter((ep) => !excludedCategories.some((exc) => ep.category?.includes(exc)))
    .map((ep) => ep.id)

  if (!claimIds.length) {
    console.log('[summarize] only excluded-category episodes transcribed')
    return { summarized: 0 }
  }

  // Atomically claim: the `.eq('status', 'transcribed')` guard ensures overlapping
  // runs can't grab the same episode (see transcribe.ts for the full rationale).
  const { data: episodes, error: claimError } = await supabaseAdmin
    .from('episode_log')
    .update({ status: 'summarizing', updated_at: new Date().toISOString() })
    .eq('station_id', stationId)
    .in('id', claimIds)
    .eq('status', 'transcribed')
    .select('*')

  if (claimError) throw new Error(`Failed to claim episodes: ${claimError.message}`)
  if (!episodes?.length) {
    console.log('[summarize] no episodes claimed (already taken by another run)')
    return { summarized: 0 }
  }

  const filteredEpisodes = episodes

  // Batch-fetch all transcripts upfront to avoid N+1 queries
  const epIds = filteredEpisodes.map((ep) => ep.id)
  const { data: transcriptsData } = await supabaseAdmin
    .from('transcripts')
    .select('episode_id, transcript, vtt')
    .in('episode_id', epIds)

  const transcriptMap = new Map(
    (transcriptsData ?? []).map((t) => [t.episode_id, t.transcript])
  )
  const vttMap = new Map(
    (transcriptsData ?? []).map((t) => [t.episode_id, t.vtt as string | null])
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

      // Air date/time are derived deterministically from the archive MP3 filename
      // at ingest (parseMp3Url + dateFieldsFromUrl) and stored as episode metadata,
      // so they're ground truth and don't need to go through the summarizer.
      const userMessage = `Show: ${episode.show_name || ''}
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
          stationId,
          episode.id,
          usage.prompt_tokens,
          usage.completion_tokens
        )
      }

      // Embed the transcript for semantic search (Phase 2). Best-effort and
      // auxiliary — like the cue populate in transcribe.ts, a failure here must
      // never fail a successfully-summarized episode (search degrades to lexical).
      if (embeddingsEnabled) {
        try {
          const vtt = vttMap.get(episode.id)
          const { rows, tokens } = await buildEpisodeChunkRows(vtt, embeddingModel, openai)
          await storeEpisodeChunks(supabaseAdmin, episode.id, rows)
          if (tokens > 0) await logEmbeddingUsage(stationId, episode.id, tokens, embeddingModel)
          if (rows.length) console.log(`[summarize] ep ${episode.id} embedded ${rows.length} chunks`)
        } catch (embErr) {
          console.warn(`[summarize] ep ${episode.id} embedding failed:`, embErr instanceof Error ? embErr.message : embErr)
        }
      }

      summarized++
      console.log(`[summarize] ep ${episode.id} done: "${parsed.headline?.slice(0, 60)}"`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[summarize] ep ${episode.id} failed:`, errMsg)
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
    }
  }

  // Check if more transcribed episodes remain after this batch (this station only —
  // the continue-chain job carries this station's id)
  const { count: remainingCount } = await supabaseAdmin
    .from('episode_log')
    .select('id', { count: 'exact', head: true })
    .eq('station_id', stationId)
    .eq('status', 'transcribed')
    .or(`and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

  const remaining = (remainingCount ?? 0) > 0
  if (remaining) {
    console.log(`[summarize] ${remainingCount} more transcribed episodes — will continue`)
  }

  if (summarized > 0) {
    void logAuditEvent({
      action: AUDIT_ACTIONS.SUMMARIZE_COMPLETE,
      operation: 'update',
      stationId,
      resourceType: 'episode',
      metadata: { summarized, remaining },
    })
  }
  return { summarized, remaining }
}
