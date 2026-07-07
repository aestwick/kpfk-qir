// Catalog of OpenAI chat models selectable for the summarization and curation
// stages (Settings → Prompts). Pure constants — safe to import from client
// pages and server code alike.
//
// Only models that support `temperature` + `response_format: json_object` are
// listed, since both pipeline call sites rely on them (reasoning-tier models
// like o4/gpt-5 reject those params). Prices are USD per 1M tokens and feed the
// usage_log cost estimates — update them if OpenAI reprices.

export interface OpenAIChatModel {
  id: string
  label: string
  /** One-line description surfaced as the dropdown hover tooltip. */
  description: string
  inputCostPerMTok: number
  outputCostPerMTok: number
}

export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini'

export const OPENAI_CHAT_MODELS: OpenAIChatModel[] = [
  {
    id: 'gpt-4o-mini',
    label: 'GPT-4o mini (default)',
    description: 'Default — fast and cheap ($0.15/$0.60 per 1M tokens); what the pipeline has always used.',
    inputCostPerMTok: 0.15,
    outputCostPerMTok: 0.6,
  },
  {
    id: 'gpt-4.1-nano',
    label: 'GPT-4.1 nano',
    description: 'Cheapest and fastest ($0.10/$0.40 per 1M tokens); fine for routine summaries, weakest judgment.',
    inputCostPerMTok: 0.1,
    outputCostPerMTok: 0.4,
  },
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 mini',
    description: 'Noticeably sharper than the default at ~3× the cost ($0.40/$1.60 per 1M tokens).',
    inputCostPerMTok: 0.4,
    outputCostPerMTok: 1.6,
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    description: 'Strong long-context model ($2/$8 per 1M tokens); best judgment on long transcripts and tricky curation.',
    inputCostPerMTok: 2,
    outputCostPerMTok: 8,
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    description: 'Capable general model ($2.50/$10 per 1M tokens — ~17× the default); rarely worth it over GPT-4.1 here.',
    inputCostPerMTok: 2.5,
    outputCostPerMTok: 10,
  },
]

/** Coerce a stored setting to a model this pipeline actually supports.
 *  Unknown/absent values fall back to the default rather than reaching OpenAI. */
export function resolveChatModel(raw: unknown): string {
  return OPENAI_CHAT_MODELS.some((m) => m.id === raw) ? (raw as string) : DEFAULT_CHAT_MODEL
}

/** Estimated USD cost of one call; unknown models are priced at the default's rates. */
export function chatModelCost(model: string, inputTokens: number, outputTokens: number): number {
  const m = OPENAI_CHAT_MODELS.find((x) => x.id === model)
    ?? OPENAI_CHAT_MODELS.find((x) => x.id === DEFAULT_CHAT_MODEL)!
  return (inputTokens * m.inputCostPerMTok + outputTokens * m.outputCostPerMTok) / 1_000_000
}
