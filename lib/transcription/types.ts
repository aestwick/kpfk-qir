// Shared types for the pluggable transcription layer.
//
// The pipeline supports multiple speech-to-text providers (Groq Whisper,
// Deepgram, AssemblyAI) tried in a configured priority order, with automatic
// fallback. Every provider normalizes its output to TranscriptionResult so the
// worker, VTT builder, and cost logger stay provider-agnostic.

export type ProviderId = 'groq' | 'deepgram' | 'assemblyai'

// One timed passage of transcript. Times are ABSOLUTE seconds from the start of
// the episode (each provider folds in any per-chunk offset before returning).
// `speaker` is set only when the provider diarized (e.g. "Speaker 0"); null/
// undefined otherwise.
export interface NormalizedSegment {
  startSec: number
  endSec: number
  text: string
  speaker?: string | null
}

export interface TranscriptionResult {
  // Clean, joined transcript text (no speaker labels) — feeds summarization.
  text: string
  // Timed segments used to build the VTT (and, when present, speaker labels).
  segments: NormalizedSegment[]
  // Total audio duration in seconds (drives cost). Best-effort per provider.
  durationSec: number
  // BCP-47-ish language code when the provider detected one, else null.
  language: string | null
  // Which engine actually produced this result (for usage logging + storage).
  providerId: ProviderId
  // The concrete model/tier used (e.g. 'whisper-large-v3', 'nova-2').
  model: string
  // True when the segments carry speaker labels.
  diarized: boolean
}

// Context handed to a provider for one episode. `getLocalChunks` lazily runs
// ffmpeg to produce 15-min M4A chunk paths — only the Groq path needs it, so a
// URL-based provider (Deepgram/AssemblyAI) never triggers a download.
export interface TranscribeContext {
  episodeId: number
  mp3Url: string
  diarize: boolean
  chunkDurationSec: number
  getLocalChunks: () => Promise<string[]>
}

export interface TranscriptionProvider {
  id: ProviderId
  label: string
  supportsDiarization: boolean
  // True when the provider's API key is present in the environment.
  isConfigured(): boolean
  transcribe(ctx: TranscribeContext): Promise<TranscriptionResult>
}

// Thrown when the source MP3 genuinely does not exist (404 / unreachable URL).
// Terminal: the worker marks the episode `unavailable` and does NOT try other
// providers (a missing file will 404 for all of them).
export class AudioUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudioUnavailableError'
  }
}

// Thrown when every enabled provider in the plan failed (none succeeded). Carries
// the per-provider error messages so the episode's error_message is actionable.
export class AllProvidersFailedError extends Error {
  attempts: Array<{ provider: ProviderId; error: string }>
  constructor(attempts: Array<{ provider: ProviderId; error: string }>) {
    super(
      attempts.length
        ? `All transcription providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(' | ')}`
        : 'No transcription provider is enabled and configured',
    )
    this.name = 'AllProvidersFailedError'
    this.attempts = attempts
  }
}
