import { Job } from 'bullmq'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'
import { getProcessingWindowBounds } from '../lib/quarters'
import { logComplianceUsage } from '../lib/usage'
import { getComplianceChecksEnabled, getComplianceModel, getCompliancePrompt, getSummarizeBatchSize, isPipelinePaused } from '../lib/settings'
import { getStation } from '../lib/stations'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { wordPattern, wordOccurrences, restrictedHoursCheck, type RestrictedAt, type WordOccurrence } from '../lib/compliance-match'
import { fetchAllRows } from '../lib/fetch-all'
import { isSecondaryFeed } from '../lib/broadcast-day'
import {
  FINGERPRINT_VERSION, LOOKBACK_DAYS, fingerprint, bestMatch, airedEarlier, findDisclosures, rerunFlagFields, type PriorAiring,
} from '../lib/rerun'

interface ComplianceFlagInsert {
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
}

// Stable identity for a flag within an episode. Used to recognise a re-surfaced
// flag across re-runs so a reviewer's triage (status + notes) survives instead
// of resetting.
function flagIdentity(f: { flag_type: string; excerpt: string | null; timestamp_seconds: number | null }): string {
  // The quoted excerpt is what semantically identifies an excerpt-bearing flag
  // (profanity, technical, AI checks); the timestamp is a *derived* convenience
  // (where to start playback), not part of identity. Keying on type+excerpt
  // when an excerpt exists means backfilling a timestamp onto a flag that had
  // none does NOT change its identity, so an already-triaged flag is preserved
  // rather than reset to 'suggested'. Excerpt-less flags (station_id_missing,
  // one per hour mark) key on the timestamp instead so multiple stay distinct.
  const locator = f.excerpt ? f.excerpt : `@${f.timestamp_seconds ?? ''}`
  return `${f.flag_type}\u0000${locator}`
}

interface VttCue {
  startSeconds: number
  endSeconds: number
  text: string
}

function parseVttTimestamp(ts: string): number {
  const parts = ts.split(':')
  if (parts.length === 3) {
    const [h, m, s] = parts
    return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)
  }
  if (parts.length === 2) {
    const [m, s] = parts
    return parseInt(m) * 60 + parseFloat(s)
  }
  return 0
}

function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = []
  const blocks = vtt.split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const [startStr, endStr] = timeLine.split('-->').map((s) => s.trim())
    const text = lines.slice(lines.indexOf(timeLine) + 1).join(' ').trim()
    if (text) {
      cues.push({
        startSeconds: parseVttTimestamp(startStr),
        endSeconds: parseVttTimestamp(endStr),
        text,
      })
    }
  }
  return cues
}

/**
 * Date window — current quarter by default, or an explicit `{ window:{start,end} }`
 * from job data for a historical backfill. Mirrors transcribe.ts/summarize.ts.
 */
function resolveWindow(job: Job): { start: string; end: string } {
  const w = job.data?.window as { start?: string; end?: string } | undefined
  if (w?.start && w?.end) return { start: w.start, end: w.end }
  return getProcessingWindowBounds()
}

function runProfanityCheck(
  episodeId: number,
  transcript: string,
  wordlist: { word: string; severity: string }[],
  restrictedAt: RestrictedAt,
  vttCues: VttCue[]
): ComplianceFlagInsert[] {
  const flags: ComplianceFlagInsert[] = []

  const flagAt = (word: string, wordSeverity: string, occ: WordOccurrence): ComplianceFlagInsert => {
    const start = Math.max(0, occ.index - 50)
    const end = Math.min(transcript.length, occ.index + word.length + 50)
    const restricted = restrictedAt(occ.time)
    return {
      episode_id: episodeId,
      flag_type: 'profanity',
      severity: restricted ? wordSeverity : 'warning',
      excerpt: transcript.slice(start, end),
      // The caption cue this occurrence was spoken in, so "Listen" jumps to it.
      timestamp_seconds: occ.time,
      details: restricted
        ? `"${word}" detected during FCC restricted hours (6am-10pm)`
        : `"${word}" detected during safe harbor hours (10pm-6am)`,
    }
  }

  for (const { word, severity: wordSeverity } of wordlist) {
    const occurrences = wordOccurrences(transcript, vttCues, word)
    if (occurrences.length === 0) continue
    // One flag per word: its first occurrence (unchanged identity, so triaged
    // rows survive a re-run). If that first one aired in safe harbor, also flag
    // the first later occurrence in restricted hours: for a show straddling
    // 6am or 10pm that's the one that matters, and it was never flagged.
    const first = occurrences[0]
    flags.push(flagAt(word, wordSeverity, first))
    if (!restrictedAt(first.time)) {
      const laterRestricted = occurrences.slice(1).find((o) => o.time != null && restrictedAt(o.time))
      if (laterRestricted) flags.push(flagAt(word, wordSeverity, laterRestricted))
    }
  }

  return flags
}

function runStationIdCheck(
  episodeId: number,
  vttCues: VttCue[],
  duration: number | null,
  stationName: string,
  idPatterns: string[]
): ComplianceFlagInsert[] {
  if (!vttCues.length || !duration) return []

  // Find hour boundaries within the episode
  const durationSecs = (duration ?? 60) * 60
  const hourMarks: number[] = []
  for (let t = 3600; t < durationSecs; t += 3600) {
    hourMarks.push(t)
  }
  // Also check the start of the episode (top of hour)
  hourMarks.unshift(0)

  const flags: ComplianceFlagInsert[] = []
  // Build the station-ID detection regex from the station's configured patterns
  // (e.g. ['kpfk','90.7']). Escape each so frequencies like '90.7' match literally.
  const escaped = idPatterns
    .filter((p) => p && p.trim())
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const stationPattern = escaped.length ? new RegExp(escaped.join('|'), 'i') : null
  // No patterns configured for this station — we don't know what to look for,
  // so skip the check rather than emit meaningless flags.
  if (!stationPattern) return []

  for (const mark of hourMarks) {
    const windowStart = Math.max(0, mark - 300) // 5 min before
    const windowEnd = mark + 300 // 5 min after

    const nearCues = vttCues.filter(
      (c) => c.startSeconds >= windowStart && c.startSeconds <= windowEnd
    )
    const found = nearCues.some((c) => stationPattern.test(c.text))

    if (!found && mark > 0) {
      // Only flag interior hour marks, not the very start
      flags.push({
        episode_id: episodeId,
        flag_type: 'station_id_missing',
        severity: 'warning',
        excerpt: null,
        timestamp_seconds: mark,
        details: `No ${stationName} station ID detected near ${Math.floor(mark / 3600)}:00:00 mark`,
      })
    }
  }

  return flags
}

function findTimestampForText(vttCues: VttCue[], searchText: string): number | null {
  const lower = searchText.toLowerCase()
  for (const cue of vttCues) {
    if (cue.text.toLowerCase().includes(lower)) {
      return Math.floor(cue.startSeconds)
    }
  }
  // Fallback: search for first few words of the excerpt
  const words = lower.split(/\s+/).slice(0, 4).join(' ')
  if (words.length > 10) {
    for (const cue of vttCues) {
      if (cue.text.toLowerCase().includes(words)) {
        return Math.floor(cue.startSeconds)
      }
    }
  }
  return null
}

function runTechnicalCheck(
  episodeId: number,
  transcript: string,
  duration: number | null,
  vttCues: VttCue[]
): ComplianceFlagInsert[] {
  const flags: ComplianceFlagInsert[] = []

  // Short transcript for long show
  if (duration && duration >= 30 && transcript.length < 500) {
    flags.push({
      episode_id: episodeId,
      flag_type: 'technical',
      severity: 'info',
      excerpt: null,
      timestamp_seconds: null,
      details: `Very short transcript (${transcript.length} chars) for a ${duration}-min show. Possible dead air or audio issues.`,
    })
  }

  // Repeated text detection (simple: check if any 100-char block appears 3+ times)
  if (transcript.length > 500) {
    const blockSize = 100
    const seen = new Map<string, number>()
    for (let i = 0; i <= transcript.length - blockSize; i += 50) {
      const block = transcript.slice(i, i + blockSize).toLowerCase().trim()
      seen.set(block, (seen.get(block) ?? 0) + 1)
    }
    const repeats = Array.from(seen.entries()).filter(([, count]) => count >= 3)
    if (repeats.length > 0) {
      flags.push({
        episode_id: episodeId,
        flag_type: 'technical',
        severity: 'info',
        excerpt: repeats[0][0].slice(0, 100),
        timestamp_seconds: null,
        details: `Repeated text blocks detected (${repeats.length} patterns repeated 3+ times). Possible audio loop.`,
      })
    }
  }

  // Technical difficulty keywords — require context that suggests actual issues,
  // not casual speech like "after we got off the air"
  const techPattern = /technical difficult|dead air|(went|was|were|go|gone|got kicked|knocked) off the air|lost (the )?signal|having .{0,20}problems? with .{0,20}(audio|signal|feed|stream|broadcast)/i
  const techMatch = transcript.match(techPattern)
  if (techMatch) {
    const idx = techMatch.index ?? 0
    const excerpt = transcript.slice(Math.max(0, idx - 30), Math.min(transcript.length, idx + 80))
    const matchedPhrase = techMatch[0]
    const timestamp = findTimestampForText(vttCues, matchedPhrase)
    flags.push({
      episode_id: episodeId,
      flag_type: 'technical',
      severity: 'info',
      excerpt,
      timestamp_seconds: timestamp,
      details: 'Transcript mentions possible technical issues',
    })
  }

  return flags
}

// Flag types the AI pass may return. Profanity/indecency depend on air time
// (FCC safe harbor), the rest don't.
const AI_FLAG_TYPES = ['payola_plugola', 'sponsor_id', 'indecency', 'profanity'] as const
type AiFlagType = (typeof AI_FLAG_TYPES)[number]
const TIME_SENSITIVE_AI_TYPES = new Set<AiFlagType>(['profanity', 'indecency'])

// An AI flag plus the offending term the model named (profanity only) — used
// to de-duplicate against the word list, never stored.
type AiFlag = ComplianceFlagInsert & { term: string | null }

// The AI reads the transcript in windows of this size so the WHOLE program is
// reviewed. (It used to read only the first 15k chars ≈ the first 15–20 min of
// an hour — lyrics or plugs later in the show were never seen.)
const AI_WINDOW_CHARS = 15000

function splitIntoWindows(text: string, size: number): string[] {
  const windows: string[] = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + size)
    // Break on whitespace so a word (or a quoted excerpt) isn't cut in half.
    if (end < text.length) {
      const ws = text.lastIndexOf(' ', end)
      if (ws > i + size / 2) end = ws
    }
    windows.push(text.slice(i, end))
    i = end
  }
  return windows
}

async function callComplianceModel(
  openai: OpenAI,
  episodeId: number,
  text: string,
  compliancePrompt: string,
  model: string,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: compliancePrompt },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      })
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const status = (err as { status?: number })?.status
      if (status && [429, 500, 502, 503].includes(status)) {
        const delay = Math.pow(2, attempt + 1) * 1000
        console.warn(`[compliance] ep ${episodeId} OpenAI error ${status}, retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastError ?? new Error('OpenAI compliance check failed after retries')
}

async function runAiComplianceCheck(
  openai: OpenAI,
  episodeId: number,
  transcript: string,
  compliancePrompt: string,
  vttCues: VttCue[],
  restrictedAt: RestrictedAt,
  model: string,
): Promise<{ flags: AiFlag[]; inputTokens: number; outputTokens: number }> {
  const flags: AiFlag[] = []
  let inputTokens = 0
  let outputTokens = 0

  for (const window of splitIntoWindows(transcript, AI_WINDOW_CHARS)) {
    const response = await callComplianceModel(openai, episodeId, window, compliancePrompt, model)
    inputTokens += response.usage?.prompt_tokens ?? 0
    outputTokens += response.usage?.completion_tokens ?? 0

    const content = response.choices[0]?.message?.content
    if (!content) continue

    let parsed: { flags?: Array<{ type: string; excerpt?: string; term?: string; details?: string; severity?: string }> }
    try {
      parsed = JSON.parse(content)
    } catch {
      console.warn(`[compliance] ep ${episodeId} invalid JSON from OpenAI: ${content.slice(0, 200)}`)
      continue
    }

    for (const f of parsed.flags ?? []) {
      // Unknown types keep the historical payola_plugola bucket so nothing the
      // model raises is silently dropped.
      const type: AiFlagType = (AI_FLAG_TYPES as readonly string[]).includes(f.type) ? (f.type as AiFlagType) : 'payola_plugola'
      const excerpt = f.excerpt?.slice(0, 200) ?? null
      // OpenAI doesn't return timing, so locate the quoted excerpt in the
      // captions to give "Listen" a place to jump to. Null if unmatched.
      const timestamp = excerpt ? findTimestampForText(vttCues, excerpt) : null
      // Same safe-harbor rule as the word list, judged at the moment it aired:
      // outside 6am–10pm, profanity/indecency are warnings, not criticals.
      const severity = TIME_SENSITIVE_AI_TYPES.has(type) && !restrictedAt(timestamp) ? 'warning' : (f.severity ?? 'warning')
      flags.push({
        episode_id: episodeId,
        flag_type: type,
        severity,
        excerpt,
        timestamp_seconds: timestamp,
        details: f.details ?? null,
        term: f.term?.trim() || null,
      })
    }
  }

  return { flags, inputTokens, outputTokens }
}

// ---------------------------------------------------------------------------
// Rerun check (lib/rerun.ts). Compares this episode's transcript fingerprint
// with every earlier airing of the same show (show_group, all feeds) over the
// last LOOKBACK_DAYS; at >= RERUN_THRESHOLD overlap it looks for an on-air
// rerun announcement. Fingerprints are cached in transcript_fingerprints and
// computed lazily, so the first check of a long-running show reads its
// back-catalogue once and every later check reads a few KB per prior.
// The online feed (`2<prefix>_…`) is ignored on both sides: it isn't broadcast,
// and it re-publishes on-air shows (and podcasts ahead of air) by design.
// ---------------------------------------------------------------------------

type GroupIndex = { groupOf: Map<string, string>; keysOf: Map<string, string[]>; nameOf: Map<string, string | null> }

async function loadShowGroups(stationId: string): Promise<GroupIndex> {
  const rows = await fetchAllRows<{ key: string; show_group: string | null; display_name: string | null; feed_name: string | null; show_name: string | null }>(
    'show_keys',
    (from, to) => supabaseAdmin.from('show_keys').select('key, show_group, display_name, feed_name, show_name').eq('station_id', stationId).order('key').range(from, to),
  )
  const groupOf = new Map<string, string>()
  const keysOf = new Map<string, string[]>()
  const nameOf = new Map<string, string | null>()
  for (const r of rows) {
    const g = r.show_group ?? r.key
    groupOf.set(r.key, g)
    keysOf.set(g, [...(keysOf.get(g) ?? []), r.key])
    nameOf.set(r.key, r.display_name ?? r.feed_name ?? r.show_name ?? null)
  }
  return { groupOf, keysOf, nameOf }
}

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Fingerprints for `ids`, from the cache where current, else computed from the
 *  transcript and stored. Episodes with no transcript are simply absent. */
async function loadFingerprints(ids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>()
  for (const part of chunk(ids, 200)) {
    const { data, error } = await supabaseAdmin
      .from('transcript_fingerprints')
      .select('episode_id, version, fingerprint')
      .in('episode_id', part)
    if (error) throw new Error(`Failed to load fingerprints: ${error.message}`)
    for (const r of data ?? []) if (r.version === FINGERPRINT_VERSION) out.set(r.episode_id, (r.fingerprint as (number | string)[]).map(Number))
  }
  const missing = ids.filter((id) => !out.has(id))
  for (const part of chunk(missing, 20)) {
    const texts = new Map<number, string>()
    const { data, error } = await supabaseAdmin.from('transcripts').select('episode_id, transcript').in('episode_id', part)
    if (error) throw new Error(`Failed to load transcripts for fingerprints: ${error.message}`)
    for (const t of data ?? []) if (t.transcript) texts.set(t.episode_id, t.transcript)
    const rows = Array.from(texts, ([episode_id, text]) => ({ episode_id, version: FINGERPRINT_VERSION, fingerprint: fingerprint(text), computed_at: new Date().toISOString() }))
    if (rows.length > 0) {
      const { error } = await supabaseAdmin.from('transcript_fingerprints').upsert(rows, { onConflict: 'episode_id' })
      if (error) console.warn(`[compliance] fingerprint cache write failed: ${error.message}`)
    }
    for (const r of rows) out.set(r.episode_id, r.fingerprint)
  }
  return out
}

function daysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

async function runRerunCheck(
  stationId: string,
  mp3Prefix: string,
  groups: GroupIndex,
  episode: { id: number; show_key: string; air_date: string | null; air_start: string | null; mp3_url: string | null },
  transcript: string,
  vttCues: VttCue[],
): Promise<ComplianceFlagInsert[]> {
  if (!episode.air_date || isSecondaryFeed(episode.mp3_url, mp3Prefix)) return []
  const group = groups.groupOf.get(episode.show_key) ?? episode.show_key
  const keys = groups.keysOf.get(group) ?? [episode.show_key]

  const candidates = await fetchAllRows<{ id: number; show_key: string; air_date: string | null; air_start: string | null; mp3_url: string | null }>(
    'rerun priors',
    (from, to) => supabaseAdmin
      .from('episode_log')
      .select('id, show_key, air_date, air_start, mp3_url')
      .eq('station_id', stationId)
      .in('show_key', keys)
      .gte('air_date', daysBefore(episode.air_date!, LOOKBACK_DAYS))
      .lte('air_date', episode.air_date!)
      .neq('id', episode.id)
      .order('id')
      .range(from, to),
  )
  const priorRows = candidates.filter((p) => !isSecondaryFeed(p.mp3_url, mp3Prefix) && airedEarlier(episode, p))
  if (priorRows.length === 0) return []

  // Always from the current text (a re-transcribe replaces it), and cached for
  // the episodes that will later be compared against this one.
  const fp = fingerprint(transcript)
  const { error: fpErr } = await supabaseAdmin
    .from('transcript_fingerprints')
    .upsert({ episode_id: episode.id, version: FINGERPRINT_VERSION, fingerprint: fp, computed_at: new Date().toISOString() }, { onConflict: 'episode_id' })
  if (fpErr) console.warn(`[compliance] fingerprint cache write failed: ${fpErr.message}`)
  const fps = await loadFingerprints(priorRows.map((p) => p.id))
  const priors: (PriorAiring & { show_name: string | null })[] = priorRows
    .filter((p) => fps.has(p.id))
    .map((p) => ({ id: p.id, air_date: p.air_date, air_start: p.air_start, fingerprint: fps.get(p.id)!, show_name: groups.nameOf.get(p.show_key) ?? null }))

  const match = bestMatch(fp, priors)
  if (!match) return []

  const { data: orig } = await supabaseAdmin.from('transcripts').select('transcript').eq('episode_id', match.prior.id).maybeSingle()
  const disclosures = findDisclosures(transcript, orig?.transcript ?? '')
  const f = rerunFlagFields(episode, match as typeof match & { prior: (typeof priors)[number] }, transcript, disclosures)
  return [{
    episode_id: episode.id,
    flag_type: 'rerun',
    severity: f.severity,
    excerpt: f.excerpt,
    timestamp_seconds: f.disclosureText ? findTimestampForText(vttCues, f.disclosureText) : null,
    details: f.details,
  }]
}

export async function processCompliance(job: Job) {
  // Service-role client bypasses RLS, so the station_id filter is the only guard.
  const stationId = job.data?.stationId as string | undefined
  if (!stationId) throw new Error('[compliance] stationId is required in job data')
  // A windowed backfill bypasses the per-station park (still honors the global
  // kill switch); a live job respects the per-station pause. Mirrors transcribe.ts.
  const paused = job.data?.window ? await isPipelinePaused() : await isPipelinePaused(stationId)
  if (paused) {
    console.log(`[compliance] paused (${job.data?.window ? 'global' : `station ${stationId}`}) — skipping`)
    return { checked: 0, remaining: false, skipped: true }
  }
  const station = await getStation(stationId)
  if (!station) throw new Error(`[compliance] station ${stationId} not found`)

  const showKey = job.data?.show_key as string | undefined
  console.log(`[compliance] starting batch for ${station.slug}...${showKey ? ` (show: ${showKey})` : ''}`)

  const checksEnabled = await getComplianceChecksEnabled(stationId)
  const compliancePrompt = await getCompliancePrompt(stationId)
  const complianceModel = await getComplianceModel()
  const batchSize = await getSummarizeBatchSize(stationId)
  const { start, end } = resolveWindow(job)

  // Build query — when processing a specific show, include already-checked episodes
  // so the user can re-run compliance on a particular show
  let query = supabaseAdmin
    .from('episode_log')
    .select('*')
    .eq('station_id', stationId)

  if (showKey) {
    query = query
      .eq('show_key', showKey)
      .in('status', ['summarized', 'compliance_checked'])
  } else {
    query = query.eq('status', 'summarized')
  }

  // Filter to the window (including null air_date episodes created during it).
  // Audit-flagged `priority` episodes are also pulled in regardless of window, and
  // ordered ahead of the backlog, so a compliance audit can complete any show's data.
  const { data: episodes, error } = await query
    .or(`priority.is.true,and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) throw new Error(`Failed to fetch episodes: ${error.message}`)
  if (!episodes?.length) {
    console.log('[compliance] no summarized episodes to check')
    return { checked: 0 }
  }

  // Batch-fetch transcripts + VTT
  const epIds = episodes.map((ep) => ep.id)
  const { data: transcriptsData } = await supabaseAdmin
    .from('transcripts')
    .select('episode_id, transcript, vtt')
    .in('episode_id', epIds)

  const transcriptMap = new Map(
    (transcriptsData ?? []).map((t) => [t.episode_id, { transcript: t.transcript, vtt: t.vtt }])
  )

  // Load profanity wordlist: the station's own terms PLUS the global base
  // (station_id IS NULL) that applies to every station. Service-role read, so
  // RLS doesn't apply — the union is explicit.
  const { data: wordlistData } = await supabaseAdmin
    .from('compliance_wordlist')
    .select('word, severity')
    .or(`station_id.eq.${stationId},station_id.is.null`)
    .eq('active', true)

  const wordlist = (wordlistData ?? []).map((w) => ({ word: w.word, severity: w.severity }))

  // Set up OpenAI if AI checks are enabled
  const needsAi = checksEnabled.payola_plugola || checksEnabled.sponsor_id || checksEnabled.indecency || checksEnabled.profanity
  let openai: OpenAI | null = null
  if (needsAi) {
    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) {
      console.warn('[compliance] OPENAI_API_KEY not set, skipping AI checks')
    } else {
      openai = new OpenAI({ apiKey: openaiKey, timeout: 5 * 60 * 1000 })
    }
  }

  // Show → show_group index for the rerun check (one read per batch).
  const showGroups = checksEnabled.rerun !== false ? await loadShowGroups(stationId) : null

  let checked = 0

  for (let i = 0; i < episodes.length; i++) {
    const episode = episodes[i]
    await job.updateProgress({ current: i + 1, total: episodes.length, episodeId: episode.id, showName: episode.show_name || episode.show_key, airDate: episode.air_date })
    try {
      const data = transcriptMap.get(episode.id)
      if (!data?.transcript) {
        console.warn(`[compliance] no transcript for episode ${episode.id}, skipping`)
        // Still mark as checked - no transcript means nothing to check
        await supabaseAdmin
          .from('episode_log')
          .update({ status: 'compliance_checked', priority: false, updated_at: new Date().toISOString() })
          .eq('id', episode.id)
        checked++
        continue
      }

      const allFlags: ComplianceFlagInsert[] = []
      const restrictedAt = restrictedHoursCheck(episode.air_start, episode.duration)

      // Parse VTT once — every check below uses it to locate flags in the audio
      // (so "Listen" in the report can jump to the offending moment).
      const vttCues = data.vtt ? parseVtt(data.vtt) : []

      // 1. Profanity check
      if (checksEnabled.profanity && wordlist.length > 0) {
        allFlags.push(...runProfanityCheck(episode.id, data.transcript, wordlist, restrictedAt, vttCues))
      }

      // 2. Station ID check
      if (checksEnabled.station_id_missing && vttCues.length > 0) {
        allFlags.push(...runStationIdCheck(episode.id, vttCues, episode.duration, station.name, station.station_id_patterns ?? []))
      }

      // 3. Technical check
      if (checksEnabled.technical) {
        allFlags.push(...runTechnicalCheck(episode.id, data.transcript, episode.duration, vttCues))
      }

      // 4. AI checks (payola, sponsor ID, profanity, indecency)
      if (openai && needsAi && compliancePrompt) {
        const aiResult = await runAiComplianceCheck(openai, episode.id, data.transcript, compliancePrompt, vttCues, restrictedAt, complianceModel)
        // Respect each check's toggle, and skip AI profanity whose offending
        // term is itself a word-list entry (the list already flagged it). Judge
        // the TERM, not the excerpt: "shit … f***" must survive for the f***.
        // No term named → keep the flag.
        const listCovers = (term: string | null) =>
          checksEnabled.profanity && !!term && wordlist.some(({ word }) => wordPattern(word).test(term))
        allFlags.push(...aiResult.flags
          .filter((f) => checksEnabled[f.flag_type] !== false && !(f.flag_type === 'profanity' && listCovers(f.term)))
          .map(({ term: _term, ...flag }) => flag))

        if (aiResult.inputTokens > 0) {
          await logComplianceUsage(stationId, episode.id, aiResult.inputTokens, aiResult.outputTokens, complianceModel)
        }
      }

      // 5. Rerun check — ≥80% of the transcript matches an earlier airing of the
      // same show; then was it announced on air? Free (no AI).
      if (showGroups) {
        allFlags.push(...await runRerunCheck(stationId, station.mp3_filename_prefix ?? station.slug, showGroups, episode, data.transcript, vttCues))
      }

      // Reconcile against existing flags rather than wiping them: when this run
      // re-surfaces a flag a reviewer already triaged (status moved off
      // 'suggested'), keep the original row so its status and notes stick.
      const { data: existingFlags } = await supabaseAdmin
        .from('compliance_flags')
        .select('id, flag_type, excerpt, timestamp_seconds, review_status')
        .eq('episode_id', episode.id)

      const newIdentities = new Set(allFlags.map(flagIdentity))
      const keptIdentities = new Set<string>()
      const keepIds: number[] = []
      for (const ef of existingFlags ?? []) {
        const key = flagIdentity(ef)
        if (ef.review_status !== 'suggested' && newIdentities.has(key) && !keptIdentities.has(key)) {
          keepIds.push(ef.id)
          keptIdentities.add(key)
        }
      }

      // Drop every existing flag except the triaged ones we're preserving
      // (stale flags that no longer surface, plus untriaged ones we'll refresh).
      let del = supabaseAdmin.from('compliance_flags').delete().eq('episode_id', episode.id)
      if (keepIds.length > 0) del = del.not('id', 'in', `(${keepIds.join(',')})`)
      await del

      // Insert only flags not already represented by a preserved row.
      const toInsert = allFlags.filter((f) => !keptIdentities.has(flagIdentity(f)))
      if (toInsert.length > 0) {
        await supabaseAdmin.from('compliance_flags').insert(toInsert)
      }

      // Update status
      await supabaseAdmin
        .from('episode_log')
        .update({ status: 'compliance_checked', priority: false, error_message: null, updated_at: new Date().toISOString() })
        .eq('id', episode.id)

      checked++
      console.log(`[compliance] ep ${episode.id} done: ${allFlags.length} flags (${toInsert.length} new, ${keepIds.length} triaged kept)`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`[compliance] ep ${episode.id} failed:`, errMsg)
      // Don't block - leave as summarized, still usable for QIR
      // Just log the error on the episode
      await supabaseAdmin
        .from('episode_log')
        .update({
          error_message: `Compliance check failed: ${errMsg.slice(0, 500)}`,
          updated_at: new Date().toISOString(),
        })
        .eq('id', episode.id)
    }
  }

  // Check if more episodes remain after this batch (this station only)
  let remainQuery = supabaseAdmin
    .from('episode_log')
    .select('id', { count: 'exact', head: true })
    .eq('station_id', stationId)

  if (showKey) {
    remainQuery = remainQuery
      .eq('show_key', showKey)
      .in('status', ['summarized', 'compliance_checked'])
  } else {
    remainQuery = remainQuery.eq('status', 'summarized')
  }

  const { count: remainingCount } = await remainQuery
    .or(`priority.is.true,and(air_date.gte.${start},air_date.lte.${end}),and(air_date.is.null,created_at.gte.${start}T00:00:00Z,created_at.lte.${end}T23:59:59Z)`)

  // For show-specific runs, "remaining" means there are more than what we just processed
  const remaining = showKey
    ? (remainingCount ?? 0) > checked
    : (remainingCount ?? 0) > 0
  if (remaining) {
    console.log(`[compliance] ${remainingCount} more episodes — will continue`)
  }

  if (checked > 0) {
    void logAuditEvent({
      action: AUDIT_ACTIONS.COMPLIANCE_COMPLETE,
      operation: 'update',
      stationId,
      resourceType: 'episode',
      metadata: { checked, remaining, showKey: showKey ?? null },
    })
  }
  return { checked, remaining }
}
