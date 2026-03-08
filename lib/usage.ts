import { supabaseAdmin } from './supabase'

// Groq Whisper pricing: $0.111 per hour of audio
const GROQ_WHISPER_COST_PER_SECOND = 0.111 / 3600

// OpenAI GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
const OPENAI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000
const OPENAI_OUTPUT_COST_PER_TOKEN = 0.60 / 1_000_000

export async function logTranscriptionUsage(
  episodeId: number,
  durationSeconds: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost = durationSeconds * GROQ_WHISPER_COST_PER_SECOND

  await supabaseAdmin.from('usage_log').insert({
    episode_id: episodeId,
    service: 'groq',
    model: 'whisper-large-v3',
    operation: 'transcribe',
    input_tokens: 0,
    output_tokens: 0,
    duration_seconds: durationSeconds,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  })
}

export async function logSummarizationUsage(
  episodeId: number,
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await supabaseAdmin.from('usage_log').insert({
    episode_id: episodeId,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'summarize',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  })
}

export async function logComplianceUsage(
  episodeId: number,
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await supabaseAdmin.from('usage_log').insert({
    episode_id: episodeId,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'compliance',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  })
}

export async function logCurationUsage(
  inputTokens: number,
  outputTokens: number,
  metadata?: Record<string, unknown>
) {
  const estimatedCost =
    inputTokens * OPENAI_INPUT_COST_PER_TOKEN +
    outputTokens * OPENAI_OUTPUT_COST_PER_TOKEN

  await supabaseAdmin.from('usage_log').insert({
    episode_id: null,
    service: 'openai',
    model: 'gpt-4o-mini',
    operation: 'curate',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    duration_seconds: null,
    estimated_cost: estimatedCost,
    metadata: metadata ?? {},
  })
}
