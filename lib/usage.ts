import { supabaseAdmin } from './supabase'
import { DEFAULT_CHAT_MODEL, chatModelCost } from './openai-models'

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

// Per-provider transcription pricing (USD per second of audio). Groq is the
// verified published rate; Deepgram/AssemblyAI are list-price estimates (their
// diarization is included free) — advisory only, adjust per account tier.
const TRANSCRIBE_COST_PER_SECOND: Record<string, number> = {
  groq: 0.111 / 3600, // $0.111 / hr (whisper-large-v3)
  deepgram: 0.0043 / 60, // $0.0043 / min (nova-2 prerecorded)
  assemblyai: 0.12 / 3600, // ~$0.12 / hr (Universal) — estimate
}

// OpenAI GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
const OPENAI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000

// OpenAI text-embedding-3-small pricing: $0.02/1M tokens
const OPENAI_EMBEDDING_COST_PER_TOKEN = 0.02 / 1_000_000

// Provider/model are recorded per call now that transcription is pluggable
// (Groq Whisper, Deepgram, AssemblyAI). Cost is derived from the provider's
// per-second rate; an unknown provider logs zero cost rather than mispricing.
export async function logTranscriptionUsage(
  stationId: string,
  episodeId: number,
  durationSeconds: number,
  options?: { provider?: string; model?: string; metadata?: Record<string, unknown> }
) {
  const provider = options?.provider ?? 'groq'
  const model = options?.model ?? 'whisper-large-v3'
  const estimatedCost = durationSeconds * (TRANSCRIBE_COST_PER_SECOND[provider] ?? 0)

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: provider,
    model,
    operation: 'transcribe',
    input_tokens: 0,
    output_tokens: 0,
    duration_seconds: durationSeconds,
    estimated_cost: estimatedCost,
    metadata: options?.metadata ?? {},
  }, 'transcription')
}

export async function logSummarizationUsage(
  stationId: string,
  episodeId: number,
  inputTokens: number,
  outputTokens: number,
  model: string = DEFAULT_CHAT_MODEL,
  metadata?: Record<string, unknown>
) {
  const estimatedCost = chatModelCost(model, inputTokens, outputTokens)

  await insertUsage({
    station_id: stationId,
    episode_id: episodeId,
    service: 'openai',
    model,
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

// Broadcast verification (scripts/verify-week.ts): one call per transcript
// checked against its claimed show/schedule slot.
export async function logVerificationUsage(
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
    operation: 'verify',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'verification')
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
  model: string = DEFAULT_CHAT_MODEL,
  metadata?: Record<string, unknown>
) {
  const estimatedCost = chatModelCost(model, inputTokens, outputTokens)

  await insertUsage({
    station_id: stationId,
    episode_id: null,
    service: 'openai',
    model,
    operation: 'curate',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  }, 'curation')
}
