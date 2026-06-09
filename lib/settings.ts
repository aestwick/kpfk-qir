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

// Whether the scheduled archive show-key discovery sync runs for a station.
// Defaults ON (opt-out): new programs on the archive are auto-imported as
// INACTIVE show_keys for review. Set the per-station override false to disable.
export async function getDiscoverySyncEnabled(stationId: string): Promise<boolean> {
  return (await getSetting<boolean>('discovery_sync_enabled', stationId)) ?? true
}

// Show keys to skip at ingest, matched exactly against show_keys.key. Keyed by
// the per-feed key (not the program name) so one airing of a show can be dropped
// while sibling airings under the same name keep running (e.g. drop KPFA's 9am
// Democracy Now! feed `dn9` while keeping the 6am `dn6`). Distinct from
// excluded_categories (matched on category). Defaults to none.
export async function getExcludedShowKeys(stationId: string): Promise<string[]> {
  return (await getSetting<string[]>('excluded_show_keys', stationId)) ?? []
}

export async function getTranscribeBatchSize(stationId: string): Promise<number> {
  return (await getSetting<number>('transcribe_batch_size', stationId)) ?? 5
}

export async function getSummarizeBatchSize(stationId: string): Promise<number> {
  return (await getSetting<number>('summarize_batch_size', stationId)) ?? 10
}

// Semantic search (Phase 2): whether the summarize worker embeds each episode's
// transcript into transcript_chunks. On by default — disable per station to stop
// the (cheap) embedding spend if a station doesn't want semantic search. The
// embedding model is pinned to 1536 dims to match the vector column; changing it
// requires re-embedding the corpus with a same-dimension model.
export async function isEmbeddingsEnabled(stationId: string): Promise<boolean> {
  return (await getSetting<boolean>('embeddings_enabled', stationId)) ?? true
}

export async function getEmbeddingModel(stationId: string): Promise<string> {
  return (await getSetting<string>('embedding_model', stationId)) ?? 'text-embedding-3-small'
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

// A station's OWN phone numbers / websites, configured per station in
// Settings → Compliance. Reading them on air (or asking listeners to call,
// visit, or become a member via them) is routine station operation, NOT
// undisclosed commercial promotion — so they're injected into the compliance
// prompt as an explicit do-not-flag list. Stored per-station (station_settings),
// support multiple values, default empty.
export async function getStationPhoneNumbers(stationId: string): Promise<string[]> {
  return (await getSetting<string[]>('station_phone_numbers', stationId)) ?? []
}

export async function getStationUrls(stationId: string): Promise<string[]> {
  return (await getSetting<string[]>('station_urls', stationId)) ?? []
}

// Append the station's own contact details to the compliance prompt so the AI
// never flags them as payola/plugola or sponsorship. No-op when none configured.
export function appendStationContactExemption(
  prompt: string,
  stationDisplayName: string,
  phoneNumbers: string[],
  urls: string[],
): string {
  const phones = phoneNumbers.map((p) => p.trim()).filter(Boolean)
  const sites = urls.map((u) => u.trim()).filter(Boolean)
  if (phones.length === 0 && sites.length === 0) return prompt
  const lines = [
    '',
    `IMPORTANT — ${stationDisplayName}'s OWN contact details. The following belong to the station itself. NEVER flag them — or appeals to call, visit, donate, or become a member via them — as payola/plugola or sponsorship; they are routine station operation:`,
  ]
  if (phones.length) lines.push(`- Station phone numbers: ${phones.join(', ')}`)
  if (sites.length) lines.push(`- Station websites: ${sites.join(', ')}`)
  return prompt + '\n' + lines.join('\n')
}

export async function getCompliancePrompt(stationId: string): Promise<string> {
  // Centralized (master-level): the FCC review prompt is read GLOBAL-only — no
  // per-station override, since the rules are federal and uniform. The station
  // name is still injected per station via {{STATION_NAME}}.
  const raw = (await getSetting<string>('compliance_prompt')) ?? DEFAULT_COMPLIANCE_PROMPT
  const name = await stationName(stationId)
  const [phones, urls] = await Promise.all([
    getStationPhoneNumbers(stationId),
    getStationUrls(stationId),
  ])
  // The station's own contact info IS per-station (each station has its own),
  // so it's layered on top of the uniform federal prompt.
  return appendStationContactExemption(fillStationName(raw, name), name, phones, urls)
}

// Centralized FCC safety gate: when on, generate-qir holds back episodes with an
// unresolved critical compliance flag. Global-only — a station can't disable it.
export async function isComplianceBlocking(): Promise<boolean> {
  return (await getSetting<boolean>('compliance_blocking')) ?? false
}

// Pipeline pause is layered: a GLOBAL master flag (qir_settings.pipeline_paused)
// pauses every station, and each station may *additionally* be paused on its own
// via station_settings(station_id, 'pipeline_paused'). The shared worker pool can
// only be BullMQ-paused as a whole — that's what the GLOBAL flag drives in
// workers/index.ts. Per-station pause can't pause the shared pool, so it's
// enforced one level up: the ingest dispatcher skips paused stations, the
// auto-chain hooks skip them, and each stage processor early-skips a job whose
// station is paused. All of those pass their stationId here.
//
// Effective state = global OR (stationId given AND that station's own flag).
// Read fresh every time — never cache. This is a control signal toggled from the
// dashboard and polled by both the UI and workers; a stale cached value makes
// Pause/Resume appear not to take effect (and shows a "PAUSED" badge over an
// actively-running pipeline). A couple of cheap boolean reads are worth it.
export async function isPipelinePaused(stationId?: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('qir_settings')
    .select('value')
    .eq('key', 'pipeline_paused')
    .maybeSingle()
  const globalPaused = parseJsonValue(data?.value) === true
  // Refresh the shared cache too, so getSetting('pipeline_paused') callers stay
  // consistent — using the same station-prefixed key getSetting reads (global).
  settingsCache.set(cacheKeyFor('pipeline_paused'), { value: globalPaused, fetchedAt: Date.now() })
  if (globalPaused) return true

  if (stationId) {
    // Effective per-station pause = own pause flag OR over its spend cap. The
    // budget check is cached and short-circuits when no cap is set, so this stays
    // cheap on the hot worker path.
    if (await isStationPaused(stationId)) return true
    return isStationOverBudget(stationId)
  }
  return false
}

/**
 * This station's *own* pause override only — ignores the GLOBAL master flag.
 * Used by the super-admin master control to show each station's individual pause
 * state, and composed by isPipelinePaused() into the effective state. Read fresh
 * (control signal — same rationale as isPipelinePaused).
 */
export async function isStationPaused(stationId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('station_settings')
    .select('value')
    .eq('station_id', stationId)
    .eq('key', 'pipeline_paused')
    .maybeSingle()
  return parseJsonValue(data?.value) === true
}

// ─── Spend limits (super-admin-managed; auto-pause enforcement) ─────────────
// Budgets live in the same key-value layers as everything else. Two independent
// layers, both enforced (a station trips if EITHER is breached):
//
//   Per-station — resolves override → global default via getSetting():
//     spend_limit_monthly / spend_limit_quarterly   (USD; absent or ≤ 0 = no cap)
//     "Global" here is a DEFAULT applied to every station; a per-station row
//     overrides it for that station.
//   Universal — a single combined ceiling on the SUM of *all* stations' spend
//     (global-only, super-admin-managed):
//     spend_limit_universal_monthly / spend_limit_universal_quarterly
//     When the all-stations total reaches it, every station trips at once.
//
// Enforcement is auto-pause only: a station over its own cap OR under a breached
// universal ceiling is treated as paused by isPipelinePaused(), which stops the
// paid stages (transcribe/summarize/compliance) and the auto-chain. Ingest is
// gated globally only, so episodes keep being captured as `pending` and drain
// once the budget resets (monthly/quarterly rollover) or is raised. The *reason*
// is never shown to non-super-admins — only the super-admin Master Control
// surfaces budget status.

function monthAndQuarterStart(): { monthStart: string; quarterStart: string } {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  return {
    monthStart: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10),
    quarterStart: new Date(now.getFullYear(), q * 3, 1).toISOString().slice(0, 10),
  }
}

/**
 * Effective per-station spend caps (per-station override → global default).
 * A non-positive or missing value means "no cap" → null.
 */
export async function getEffectiveSpendLimits(stationId: string): Promise<{ monthly: number | null; quarterly: number | null }> {
  const [m, q] = await Promise.all([
    getSetting<number>('spend_limit_monthly', stationId),
    getSetting<number>('spend_limit_quarterly', stationId),
  ])
  return {
    monthly: typeof m === 'number' && m > 0 ? m : null,
    quarterly: typeof q === 'number' && q > 0 ? q : null,
  }
}

/**
 * Universal (all-stations combined) spend ceiling — global-only.
 * A non-positive or missing value means "no cap" → null.
 */
export async function getUniversalSpendLimits(): Promise<{ monthly: number | null; quarterly: number | null }> {
  const [m, q] = await Promise.all([
    getSetting<number>('spend_limit_universal_monthly'),
    getSetting<number>('spend_limit_universal_quarterly'),
  ])
  return {
    monthly: typeof m === 'number' && m > 0 ? m : null,
    quarterly: typeof q === 'number' && q > 0 ? q : null,
  }
}

// Month-to-date and quarter-to-date spend, optionally scoped to one station
// (one quarter-spanning read; month ⊆ quarter).
async function sumSpend(stationId?: string): Promise<{ month: number; quarter: number }> {
  const { monthStart, quarterStart } = monthAndQuarterStart()
  let query = supabaseAdmin
    .from('usage_log')
    .select('estimated_cost, created_at')
    .gte('created_at', quarterStart)
  if (stationId) query = query.eq('station_id', stationId)
  const { data } = await query
  let month = 0
  let quarter = 0
  for (const r of data ?? []) {
    const amt = Number(r.estimated_cost) || 0
    quarter += amt
    if (typeof r.created_at === 'string' && r.created_at.slice(0, 10) >= monthStart) month += amt
  }
  return { month, quarter }
}

/** Month-to-date and quarter-to-date spend for one station. */
export async function getStationSpend(stationId: string): Promise<{ month: number; quarter: number }> {
  return sumSpend(stationId)
}

/** Month-to-date and quarter-to-date spend across every station (universal cap). */
export async function getTotalSpend(): Promise<{ month: number; quarter: number }> {
  return sumSpend()
}

// Cached over-budget checks for the hot worker pause path. Spend accrues slowly,
// so a 60s cache bounds the cost of the usage_log sum (worst case: a station
// overshoots by ~one job before the next stage skips). Fast path with no spend
// query at all when no cap is configured — the common case.
const budgetCache = new Map<string, { over: boolean; fetchedAt: number }>()
const BUDGET_CACHE_TTL_MS = 60_000
let universalBudgetCache: { over: boolean; fetchedAt: number } | null = null

/** True when the combined all-stations spend has reached the universal ceiling. */
export async function isUniversalOverBudget(): Promise<boolean> {
  if (universalBudgetCache && Date.now() - universalBudgetCache.fetchedAt < BUDGET_CACHE_TTL_MS) {
    return universalBudgetCache.over
  }
  const { monthly, quarterly } = await getUniversalSpendLimits()
  let over = false
  if (monthly != null || quarterly != null) {
    const { month, quarter } = await getTotalSpend()
    over = (monthly != null && month >= monthly) || (quarterly != null && quarter >= quarterly)
  }
  universalBudgetCache = { over, fetchedAt: Date.now() }
  return over
}

export async function isStationOverBudget(stationId: string): Promise<boolean> {
  // Universal ceiling trips every station at once — check it first (cached,
  // station-independent, with a no-query fast path when unset).
  if (await isUniversalOverBudget()) return true

  const cached = budgetCache.get(stationId)
  if (cached && Date.now() - cached.fetchedAt < BUDGET_CACHE_TTL_MS) return cached.over

  const { monthly, quarterly } = await getEffectiveSpendLimits(stationId)
  let over = false
  if (monthly != null || quarterly != null) {
    const { month, quarter } = await getStationSpend(stationId)
    over = (monthly != null && month >= monthly) || (quarterly != null && quarter >= quarterly)
  }
  budgetCache.set(stationId, { over, fetchedAt: Date.now() })
  return over
}

/** Drop the cached over-budget results so a limit change takes effect promptly. */
export function invalidateBudgetCache(): void {
  budgetCache.clear()
  universalBudgetCache = null
}

/** Replace the {{STATION_NAME}} placeholder used in parameterized prompts. */
export function fillStationName(text: string, name: string): string {  return text.split('{{STATION_NAME}}').join(name)
}

async function stationName(stationId: string): Promise<string> {
  const station = await getStation(stationId)
  return station?.name ?? ''
}

export const DEFAULT_SUMMARIZATION_PROMPT = `You are an expert public radio producer for {{STATION_NAME}}.
Your task is to produce an internal archival log of a radio broadcast based on a transcript, and to flag any clear conflicts with provided metadata.
This is NOT a program description or promotional summary.
INPUTS:
- Episode metadata (may include show title, listed host(s), listed guest(s))
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
- Compare the provided metadata fields (show name, host, guest) with what is explicitly stated in the transcript.
- Only flag a conflict when a metadata field directly contradicts an explicit statement in the transcript (e.g., listed host name differs from who introduces themselves).
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

1. PAYOLA/PLUGOLA: Undisclosed commercial promotion. Flag if a host promotes a product, service, or business without disclosure. Do NOT flag: pledge drive fundraising, promoting station events, the station's own contact information (its phone number, website, mailing address, or social media handles), membership/donation/subscription appeals for the station itself, journalistic discussion of books/films/music, or interviews where guests mention their own work in context.

2. SPONSOR IDENTIFICATION: Segments that sound like sponsored or paid content without proper FCC disclosure. Do NOT flag the station identifying or promoting itself — reading its own call sign, frequency, phone number, website, or asking listeners to donate or become members is required/expected station operation, not a sponsored segment.

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
