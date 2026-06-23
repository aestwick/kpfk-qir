// Transcription provider registry + fallback orchestration.
//
// The worker calls runTranscription() with a per-episode context; this module
// resolves the station's configured provider order (priority + enable toggles),
// filters to providers whose API key is present, and tries each in turn until one
// succeeds. A genuine 404 (AudioUnavailableError) is terminal and re-thrown.

import { getTranscriptionProviders, isDiarizationEnabled } from '../settings'
import { groqProvider } from './groq'
import { deepgramProvider } from './deepgram'
import { assemblyaiProvider } from './assemblyai'
import {
  AllProvidersFailedError,
  AudioUnavailableError,
} from './types'
import type {
  ProviderId,
  TranscribeContext,
  TranscriptionProvider,
  TranscriptionResult,
} from './types'

export * from './types'
export { isDiarizationEnabled }

// Single source of truth for which providers exist and in what default order.
export const PROVIDERS: Record<ProviderId, TranscriptionProvider> = {
  groq: groqProvider,
  deepgram: deepgramProvider,
  assemblyai: assemblyaiProvider,
}

export const PROVIDER_ORDER: ProviderId[] = ['groq', 'deepgram', 'assemblyai']

function isProviderId(x: unknown): x is ProviderId {
  return x === 'groq' || x === 'deepgram' || x === 'assemblyai'
}

/**
 * Resolve the ordered list of providers to attempt for a station: the configured
 * priority order, keeping only entries that are enabled AND have their API key
 * present in the environment. Unknown/duplicate ids are ignored; any configured
 * provider that the registry knows but the setting omits is appended in default
 * order (so a newly-added provider isn't silently invisible).
 */
export async function resolveProviderPlan(stationId: string): Promise<TranscriptionProvider[]> {
  const configured = await getTranscriptionProviders(stationId)
  const seen = new Set<ProviderId>()
  const ordered: ProviderId[] = []

  for (const entry of configured) {
    const id = entry?.provider
    if (!isProviderId(id) || seen.has(id)) continue
    seen.add(id)
    if (entry.enabled) ordered.push(id)
  }

  return ordered.map((id) => PROVIDERS[id]).filter((p) => p.isConfigured())
}

/**
 * Try each provider in plan order until one returns a result. Re-throws
 * AudioUnavailableError immediately (the MP3 is gone — no point trying others).
 * Throws AllProvidersFailedError when the plan is empty or every provider failed.
 */
export async function runTranscription(
  ctx: TranscribeContext,
  plan: TranscriptionProvider[],
): Promise<TranscriptionResult> {
  const attempts: Array<{ provider: ProviderId; error: string }> = []

  for (const provider of plan) {
    try {
      const result = await provider.transcribe(ctx)
      if (attempts.length) {
        console.warn(
          `[transcribe] ep ${ctx.episodeId} succeeded on ${provider.id} after ${attempts.length} failed provider(s)`,
        )
      }
      return result
    } catch (err) {
      if (err instanceof AudioUnavailableError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[transcribe] ep ${ctx.episodeId} provider ${provider.id} failed: ${msg}`)
      attempts.push({ provider: provider.id, error: msg.slice(0, 200) })
    }
  }

  throw new AllProvidersFailedError(attempts)
}

// ─── Cost estimation ────────────────────────────────────────────────────────
// Per-second USD rates. Groq is the verified published rate; Deepgram/AssemblyAI
// are list-price estimates (diarization is included free on both) — adjust if the
// account is on a different tier. estimated_cost is advisory, not billed.
const COST_PER_SECOND: Record<ProviderId, number> = {
  groq: 0.111 / 3600, // $0.111 / hr (whisper-large-v3)
  deepgram: 0.0043 / 60, // $0.0043 / min (nova-2 prerecorded)
  assemblyai: 0.12 / 3600, // ~$0.12 / hr (Universal) — estimate
}

export function estimateTranscriptionCost(providerId: ProviderId, durationSec: number): number {
  return durationSec * (COST_PER_SECOND[providerId] ?? 0)
}

// Non-secret config status for the dashboard: which provider keys are present.
// Never exposes the key value — only its presence.
export function providerConfigStatus(): Record<ProviderId, boolean> {
  return {
    groq: PROVIDERS.groq.isConfigured(),
    deepgram: PROVIDERS.deepgram.isConfigured(),
    assemblyai: PROVIDERS.assemblyai.isConfigured(),
  }
}
