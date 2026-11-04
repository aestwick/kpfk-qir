// Catalog of Groq Whisper models selectable for transcription
// (Settings → Pipeline → Transcription Providers). Pure constants — safe to
// import from client pages and server code alike. Mirrors lib/openai-models.ts.
//
// Prices are USD per hour of audio from groq.com/pricing and feed the usage_log
// cost estimates — update them if Groq reprices.

export interface GroqWhisperModel {
  id: string
  label: string
  /** One-line description surfaced as the dropdown hover tooltip. */
  description: string
  costPerHour: number
}

// Turbo is the default: near-large-v3 accuracy at ~36% of the price. Chosen
// 2026-11 when transcription was ~98% of QIR's AI spend (~$100/mo on large-v3).
export const DEFAULT_GROQ_MODEL = 'whisper-large-v3-turbo'

export const GROQ_WHISPER_MODELS: GroqWhisperModel[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: 'Whisper large-v3 turbo (default)',
    description: 'Default — $0.04/hr of audio. Near large-v3 accuracy; slightly weaker on non-English and rare names.',
    costPerHour: 0.04,
  },
  {
    id: 'whisper-large-v3',
    label: 'Whisper large-v3',
    description: 'Full model — $0.111/hr of audio (~2.8× turbo). Best accuracy, especially non-English speech.',
    costPerHour: 0.111,
  },
]

/** Coerce a stored setting to a model this pipeline supports.
 *  Unknown/absent values fall back to the default rather than reaching Groq. */
export function resolveGroqModel(raw: unknown): string {
  return GROQ_WHISPER_MODELS.some((m) => m.id === raw) ? (raw as string) : DEFAULT_GROQ_MODEL
}

/** USD per second of audio; unknown models are priced at the default's rate. */
export function groqCostPerSecond(model?: string | null): number {
  const m = GROQ_WHISPER_MODELS.find((x) => x.id === model)
    ?? GROQ_WHISPER_MODELS.find((x) => x.id === DEFAULT_GROQ_MODEL)!
  return m.costPerHour / 3600
}
