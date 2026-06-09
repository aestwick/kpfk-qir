import { supabaseAdmin } from './supabase'

// usage_log.station_id is NOT NULL — every row must carry the tenant it belongs
// to. These inserts are best-effort (a logging failure must never fail the
// pipeline stage that produced the work), but we surface the error instead of
// swallowing it silently, since a silently-dropped insert is what previously
// hid a missing-station_id regression for every non-embedding operation.
async function insertUsage(row: Record<string, unknown>, context: string) {
  const { error } = await supabaseAdmin.from('usage_log').insert(row)
  if (error) {
    console.warn(`[usage] failed to log ${context} usage:`, error.message)
  }
}

// Per-hour audio transcription pricing by provider (USD), converted to per-second.
//   groq (whisper-large-v3): $0.111/hr
//   assemblyai (Best/Universal async): ~$0.27/hr
//   deepgram (Nova-2 prerecorded): ~$0.258/hr ($0.0043/min)
// These are list-price estimates used only for the cost dashboard, not billing.
const TRANSCRIPTION_COST_PER_SECOND: Record<string, number> = {
  groq: 0.111 / 3600,
  assemblyai: 0.27 / 3600,
  deepgram: 0.258 / 3600,
}
const GROQ_WHISPER_COST_PER_SECOND = TRANSCRIPTION_COST_PER_SECOND.groq

// OpenAI GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
const OPENAI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000

// OpenAI text-embedding-3-small pricing: $0.02/1M tokens
const OPENAI_EMBEDDING_COST_PER_TOKEN = 0.02 / 1_000_000

export async function logTranscriptionUsage(
  stationId: string,
  episodeId: number,
  durationSeconds: number,
  opts?: { provider?: string; model?: string; metadata?: Record<string, unknown> }
) {
  const provider = opts?.provider ?? 'groq'
  const costPerSecond = TRANSCRIPTION_COST_PER_SECOND[provider] ?? GROQ_WHISPER_COST_PER_SECOND
  const estimatedCost = durationSeconds * costPerSecond

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: provider,
    model: opts?.model ?? 'whisper-large-v3',
    operation: 'transcribe',
    input_tokens: 0,
    output_tokens: 0,
    duration_seconds: durationSeconds,
    estimated_cost: estimatedCost,
    metadata: opts?.metadata ?? {},
  }, 'transcription')
}

export async function logSummarizationUsage(
  stationId: string,
  episodeId: number,
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'summarize',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'summarization')
}

export async function logComplianceUsage(
  stationId: string,
  episodeId: number,
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'compliance',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'compliance')
}

// Corpus embedding for semantic search (Phase 2). episode_id may be null
// (e.g. a future ad-hoc embed); for the per-episode corpus embed it is set.
export async function logEmbeddingUsage(
  stationId: string,
  episodeId: number | null,
  inputTokens: number,
  model = 'text-embedding-3-small',
  metadata?: Record<string, unknown>
) {
  const estimatedCost = inputTokens * OPENAI_EMBEDDING_COST_PER_TOKEN

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: 'openai',
    model,
    operation: 'embed',
    input_tokens: inputTokens,
    output_tokens: 0,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'embedding')
}

export async function logCurationUsage(
  stationId: string,
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await insertUsage({
    station_id: stationId,
    episode_id: null,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'curate',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'curation')
}
