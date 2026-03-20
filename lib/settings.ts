import { supabaseAdmin } from './supabase'

const settingsCache = new Map<string, { value: unknown; fetchedAt: number }>()
const CACHE_TTL_MS = 60_000 // 1 minute

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  const cached = settingsCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value as T
  }

  const { data } = await supabaseAdmin
    .from('qir_settings')
    .select('value')
    .eq('key', key)
    .single()

  if (data) {
    let parsed: unknown = data.value
    if (typeof data.value === 'string') {
      try {
        parsed = JSON.parse(data.value)
      } catch {
        // keep as string if not valid JSON
      }
    }
    settingsCache.set(key, { value: parsed, fetchedAt: Date.now() })
    return parsed as T
  }

  return null
}

export async function getExcludedCategories(): Promise<string[]> {
  return (await getSetting<string[]>('excluded_categories')) ?? ['Music', 'Español']
}

export async function getTranscribeBatchSize(): Promise<number> {
  return (await getSetting<number>('transcribe_batch_size')) ?? 5
}

export async function getSummarizeBatchSize(): Promise<number> {
  return (await getSetting<number>('summarize_batch_size')) ?? 10
}

export async function getComplianceChecksEnabled(): Promise<Record<string, boolean>> {
  return (await getSetting<Record<string, boolean>>('compliance_checks_enabled')) ?? {
    profanity: true,
    station_id_missing: true,
    technical: true,
    payola_plugola: true,
    sponsor_id: true,
    indecency: true,
  }
}

export async function getCompliancePrompt(): Promise<string> {
  return (await getSetting<string>('compliance_prompt')) ?? ''
}

export async function isComplianceBlocking(): Promise<boolean> {
  return (await getSetting<boolean>('compliance_blocking')) ?? false
}

export async function isPipelinePaused(): Promise<boolean> {
  return (await getSetting<boolean>('pipeline_paused')) ?? false
}

export const DEFAULT_SUMMARIZATION_PROMPT = `You are an expert public radio producer for KPFK.
Your task is to produce an internal archival log of a radio broadcast based on a transcript, and to flag any clear conflicts with provided metadata.
This is NOT a program description or promotional summary.
INPUTS:
- Episode metadata (may include show title, air date/time, listed host(s), listed guest(s))
- A transcript of the broadcast
GENERAL RULES:
- Be concise, neutral, and factual.
- Do NOT add opinions, analysis, praise, criticism, political framing, or moral judgment.
- Do NOT explain why topics matter.
- Do NOT describe significance, impact, importance, implications, or future outcomes.
- Do NOT narrate structure, flow, or progression.
- Never invent names, roles, relationships, motivations, or conclusions.
- If something is unclear or not explicitly stated, leave it blank.
LANGUAGE RULES:
- Do NOT use: "In this episode", "This episode", "The show", "The program", "This broadcast".
- Do NOT describe beginnings, endings, transitions, or conclusions.
- Do NOT use verbs such as: "highlights", "emphasizes", "underscores", "examines", "explores", "addresses", "reflects", "focuses on", "concludes", "reviews".
- Use only neutral, descriptive verbs such as: "discusses", "describes", "outlines", "explains", "states", "argues".
- Prefer speaker-led or topic-led sentences.
- When a claim or opinion appears, attribute it to the speaker.
DISCREPANCY RULE:
- Compare the provided metadata fields (show name, air date, host, guest) with what is explicitly stated in the transcript.
- Only flag a conflict when a metadata field directly contradicts an explicit statement in the transcript (e.g., listed host name differs from who introduces themselves).
- A New Year's greeting or holiday reference that matches the air date year is NOT a discrepancy.
- Do NOT compare transcript content against your own knowledge or the current date — only compare against the provided metadata.
- Do NOT guess, infer, resolve, or explain conflicts.
- If there is no clear conflict, leave "discrepancy" blank.
CONTENT REQUIREMENTS:
HEADLINE: One short declarative sentence listing main subjects. No dates, adjectives, or conclusions.
SUMMARY: 4-8 sentences. Each states a topic or speaker statement. No structure descriptions. Under 900 characters.
HOST: Name(s) only if explicitly stated in transcript. Comma-separated if multiple. Blank if unclear.
GUEST: Name(s) only if explicitly introduced. Comma-separated if multiple. Blank if none/unclear.
ISSUE_CATEGORY: One of: Civil Rights / Social Justice, Immigration, Economy / Labor, Environment / Climate, Government / Politics, Health, International Affairs / War & Peace, Arts & Culture.
OUTPUT: Return ONLY valid JSON. No markdown, no extra text.
{"headline":"string","summary":"string","host":"string","guest":"string","discrepancy":"string","issue_category":"string"}`

export const DEFAULT_CURATION_PROMPT = `You are an expert public radio producer helping select the most significant programming entries for an FCC Quarterly Issues Report.

You will receive a list of radio program entries grouped by issue category. For each category, select up to the specified maximum number of entries that best demonstrate community service.

SELECTION CRITERIA (in order of priority):
1. Variety of shows — avoid picking many entries from the same show
2. Substantive content — clear topics, identified guests, meaningful descriptions
3. Date range — spread across the quarter, not clustered in one period
4. EXCLUDE: pledge drives, promotions, entertainment without clear community issue connection

OUTPUT: Return ONLY valid JSON. No markdown, no extra text.
Return an object where keys are category names and values are arrays of episode IDs that should be included.
Example: {"Civil Rights / Social Justice": [123, 456, 789], "Health": [101, 202]}`

export async function getSummarizationPrompt(): Promise<string> {
  return (await getSetting<string>('summarization_prompt')) ?? DEFAULT_SUMMARIZATION_PROMPT
}

export async function getCurationPrompt(): Promise<string> {
  return (await getSetting<string>('curation_prompt')) ?? DEFAULT_CURATION_PROMPT
}

export async function getIssueCategories(): Promise<string[]> {
  return (await getSetting<string[]>('issue_categories')) ?? [
    'Civil Rights / Social Justice',
    'Immigration',
    'Economy / Labor',
    'Environment / Climate',
    'Government / Politics',
    'Health',
    'International Affairs / War & Peace',
    'Arts & Culture',
  ]
}
