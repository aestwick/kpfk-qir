import { supabaseAdmin } from './supabase'
import { getStation } from './stations'

const settingsCache = new Map<string, { value: unknown; fetchedAt: number }>()
const CACHE_TTL_MS = 60_000 // 1 minute

function parseJsonValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw)
    } catch {
      // keep as string if not valid JSON
    }
  }
  return raw
}

// The cache is keyed by station so stations never read each other's values.
// One canonical key builder, used by every read/write/invalidate path.
function cacheKeyFor(key: string, stationId?: string): string {
  return `${stationId ?? 'global'}:${key}`
}

/**
 * Resolve a setting. When stationId is given, resolution order is:
 *   1. station_settings(station_id, key)   — this station's override
 *   2. qir_settings(key)                    — global default layer
 *   3. null                                 — caller supplies a hard-coded default
 * When stationId is omitted, only the global qir_settings layer is consulted
 * (for truly global operational flags like pipeline_paused/pipeline_mode).
 *
 * The 60s cache is keyed by (stationId|'global', key) so stations never read
 * each other's values.
 */
export async function getSetting<T = unknown>(key: string, stationId?: string): Promise<T | null> {
  const cacheKey = cacheKeyFor(key, stationId)
  const cached = settingsCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value as T
  }

  // 1. Per-station override.
  if (stationId) {
    const { data: override } = await supabaseAdmin
      .from('station_settings')
      .select('value')
      .eq('station_id', stationId)
      .eq('key', key)
      .maybeSingle()
    if (override) {
      const parsed = parseJsonValue(override.value)
      settingsCache.set(cacheKey, { value: parsed, fetchedAt: Date.now() })
      return parsed as T
    }
  }

  // 2. Global default layer. Log when a station falls back to it (sanctioned
  // fallback per the plan — kept visible, not silent). Cached, so this logs at
  // most once per 60s per (station, key).
  if (stationId) {
    console.log(`[settings] station ${stationId} has no override for '${key}' — using global qir_settings`)
  }
  const { data } = await supabaseAdmin
    .from('qir_settings')
    .select('value')
    .eq('key', key)
    .maybeSingle()

  if (data) {
    const parsed = parseJsonValue(data.value)
    settingsCache.set(cacheKey, { value: parsed, fetchedAt: Date.now() })
    return parsed as T
  }

  return null
}

/**
 * Drop a cached setting (or the whole cache) so the next read hits the DB.
 * Call after writing a setting so changes like pause/resume take effect
 * immediately instead of lagging up to CACHE_TTL_MS. Cache keys are
 * station-prefixed, so clear this key for every station.
 */
export function invalidateSetting(key?: string): void {
  if (!key) {
    settingsCache.clear()
    return
  }
  const suffix = `:${key}`
  for (const k of Array.from(settingsCache.keys())) {
    if (k.endsWith(suffix)) settingsCache.delete(k)
  }
}

export async function getExcludedCategories(stationId: string): Promise<string[]> {
  return (await getSetting<string[]>('excluded_categories', stationId)) ?? ['Music', 'Español']
}

export async function getTranscribeBatchSize(stationId: string): Promise<number> {
  return (await getSetting<number>('transcribe_batch_size', stationId)) ?? 5
}

export async function getSummarizeBatchSize(stationId: string): Promise<number> {
  return (await getSetting<number>('summarize_batch_size', stationId)) ?? 10
}

export async function getComplianceChecksEnabled(stationId: string): Promise<Record<string, boolean>> {
  return (await getSetting<Record<string, boolean>>('compliance_checks_enabled', stationId)) ?? {
    profanity: true,
    station_id_missing: true,
    technical: true,
    payola_plugola: true,
    sponsor_id: true,
    indecency: true,
  }
}

export async function getCompliancePrompt(stationId: string): Promise<string> {
  const raw = (await getSetting<string>('compliance_prompt', stationId)) ?? DEFAULT_COMPLIANCE_PROMPT
  return fillStationName(raw, await stationName(stationId))
}

export async function isComplianceBlocking(stationId: string): Promise<boolean> {
  return (await getSetting<boolean>('compliance_blocking', stationId)) ?? false
}

// Pipeline pause is a GLOBAL operational flag — the worker pool is shared across
// stations, so pausing pauses everything. Kept global (no stationId) by design.
export async function isPipelinePaused(): Promise<boolean> {
  // Read fresh every time — never cache. This is a control signal toggled from
  // the dashboard and polled by both the UI and workers; a stale cached value
  // makes Pause/Resume appear not to take effect (and shows a "PAUSED" badge
  // over an actively-running pipeline). A single cheap boolean read is worth it.
  const { data } = await supabaseAdmin
    .from('qir_settings')
    .select('value')
    .eq('key', 'pipeline_paused')
    .single()

  let value: unknown = data?.value
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      // keep as-is
    }
  }
  // Refresh the shared cache too, so getSetting('pipeline_paused') callers stay
  // consistent — using the same station-prefixed key getSetting reads (global).
  settingsCache.set(cacheKeyFor('pipeline_paused'), { value: value ?? false, fetchedAt: Date.now() })
  return value === true
}

/** Replace the {{STATION_NAME}} placeholder used in parameterized prompts. */
export function fillStationName(text: string, name: string): string {
  return text.split('{{STATION_NAME}}').join(name)
}

async function stationName(stationId: string): Promise<string> {
  const station = await getStation(stationId)
  return station?.name ?? ''
}

export const DEFAULT_SUMMARIZATION_PROMPT = `You are an expert public radio producer for {{STATION_NAME}}.
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

// Default compliance prompt with the station-name placeholder. The KPFK-seeded
// value in qir_settings (migration 004) still references KPFK literally; that is
// a documented global default — other stations should set a station_settings
// override (or use {{STATION_NAME}}) for their own compliance prompt.
export const DEFAULT_COMPLIANCE_PROMPT = `You are an FCC compliance reviewer for {{STATION_NAME}}, a noncommercial community radio station.

Review the following transcript for potential compliance issues. Look for:

1. PAYOLA/PLUGOLA: Undisclosed commercial promotion. Flag if a host promotes a product, service, or business without disclosure. Do NOT flag: pledge drive fundraising, promoting station events, journalistic discussion of books/films/music, or interviews where guests mention their own work in context.

2. SPONSOR IDENTIFICATION: Segments that sound like sponsored or paid content without proper FCC disclosure.

3. INDECENCY/SEXUAL CONTENT: Graphic or explicit sexual references that could violate FCC indecency standards during safe harbor restricted hours (6am-10pm). Do NOT flag: clinical/medical terminology in health education, age-appropriate sex education, news reporting on sexual assault, or academic/documentary context.

Return ONLY valid JSON. If no issues found, return empty flags array.
{
  "flags": [
    {
      "type": "payola_plugola" | "sponsor_id" | "indecency",
      "excerpt": "relevant quote from transcript (under 200 chars)",
      "details": "brief explanation of the concern",
      "severity": "warning" | "critical"
    }
  ]
}`

export async function getSummarizationPrompt(stationId: string): Promise<string> {
  const raw = (await getSetting<string>('summarization_prompt', stationId)) ?? DEFAULT_SUMMARIZATION_PROMPT
  return fillStationName(raw, await stationName(stationId))
}

export async function getCurationPrompt(stationId: string): Promise<string> {
  const raw = (await getSetting<string>('curation_prompt', stationId)) ?? DEFAULT_CURATION_PROMPT
  return fillStationName(raw, await stationName(stationId))
}

export async function getIssueCategories(stationId: string): Promise<string[]> {
  return (await getSetting<string[]>('issue_categories', stationId)) ?? [
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
