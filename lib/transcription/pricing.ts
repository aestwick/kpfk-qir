// Single source of truth for transcription pricing (USD per second of audio).
// Pure — no settings/DB imports — so lib/usage.ts can use it without pulling in
// the provider registry. Groq is priced per model (lib/groq-models.ts);
// Deepgram/AssemblyAI are list-price estimates (diarization included free) —
// advisory only, adjust per account tier. estimated_cost is not billed.

import { groqCostPerSecond } from '../groq-models'

const FLAT_COST_PER_SECOND: Record<string, number> = {
  deepgram: 0.0043 / 60, // $0.0043 / min (nova-2 prerecorded)
  assemblyai: 0.12 / 3600, // ~$0.12 / hr (Universal) — estimate
}

/** Unknown providers price at zero rather than mispricing. */
export function transcriptionCostPerSecond(provider: string, model?: string | null): number {
  if (provider === 'groq') return groqCostPerSecond(model)
  return FLAT_COST_PER_SECOND[provider] ?? 0
}

/**
 * usage_log.service values written by transcription (logTranscriptionUsage
 * records the actual provider). Cost rollups bucket spend as transcription vs
 * OpenAI with this, so Deepgram/AssemblyAI fallbacks aren't dropped or
 * misfiled when they — not Groq — produced a transcript.
 */
export const TRANSCRIPTION_SERVICES = ['groq', 'deepgram', 'assemblyai'] as const

export function isTranscriptionService(service: string | null | undefined): boolean {
  return !!service && (TRANSCRIPTION_SERVICES as readonly string[]).includes(service)
}
