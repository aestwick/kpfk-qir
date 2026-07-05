/**
 * Broadcast-week verification: did what actually aired match what we expected
 * to air? Reconciles episode_log (actual airings + transcripts) against the
 * expected programming grid — the CMS sibling app's cms_schedule_slots, read
 * read-only from the shared database — and writes a per-day review report.
 *
 * Two layers:
 *   1. Structural (always, free): expand the schedule into expected blocks per
 *      day and match airings by show identity + time overlap. Flags missing /
 *      partial blocks, unscheduled airings (and what they displaced), airings
 *      without transcripts, and pending episodes stranded behind the pipeline's
 *      current-quarter gate (fix: backfill-quarter --kick).
 *   2. Content (--verify, ~150-200 gpt-4o-mini calls/week, a few cents): read
 *      each airing's transcript and check the content actually supports the
 *      claimed show — catches reruns, pledge drives, substitute programming,
 *      and dead air that the log alone can't reveal. Cost is logged to
 *      usage_log (operation 'verify').
 *
 *   npm run verify-week -- --station kpfk                  # last 7 days, structural only
 *   npm run verify-week -- --station kpfk --verify         # + AI transcript check
 *   npm run verify-week -- --station kpfk --start 2026-06-29 --end 2026-07-05
 *
 * Output: summary to stdout + markdown/JSON reports in --out (default reports/).
 * The output is a review aid, not a pass/fail — preemptions and specials are
 * legitimate; a human decides what's actually wrong.
 *
 * Requirements: worker env (SUPABASE service role; OPENAI_API_KEY for --verify).
 * Read-only against the CMS tables; the only writes are usage_log rows.
 */
import OpenAI from 'openai'
import * as fs from 'fs/promises'
import * as path from 'path'
import { supabaseAdmin } from '../lib/supabase'
import { logVerificationUsage } from '../lib/usage'
import {
  expandBlocks,
  enrichBlocks,
  reconcileDay,
  datesInWindow,
  minToTime,
  weekdayOf,
  type Airing,
  type CmsShow,
  type DayReport,
  type QirShowKeyInfo,
  type ScheduleSlot,
} from '../lib/verify-week'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

interface Args {
  station: string
  start: string
  end: string
  verify: boolean
  out: string
}

interface AiVerdict {
  consistent: boolean
  content_type: 'regular' | 'rerun' | 'pledge_drive' | 'different_program' | 'technical_issue' | 'unclear'
  confidence: 'high' | 'medium' | 'low'
  evidence: string
}

interface PipelineIssue {
  episodeId: number
  showName: string | null
  airDate: string
  airStart: string | null
  status: string
  issue: string
}

/** Today's date in the station's timezone (air_date is station-local). */
function localDate(timeZone: string, daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(d)
}

function currentQuarterStart(timeZone: string): string {
  const today = localDate(timeZone)
  const [y, m] = today.split('-').map((v) => parseInt(v, 10))
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1
  return `${y}-${String(startMonth).padStart(2, '0')}-01`
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  if (!station) {
    throw new Error(
      'Usage: tsx scripts/verify-week.ts --station <slug> [--start YYYY-MM-DD --end YYYY-MM-DD] [--verify] [--out <dir>]'
    )
  }
  const start = get('--start')
  const end = get('--end')
  if ((start && !end) || (!start && end)) throw new Error('--start and --end must be given together')
  if (start && end && start > end) throw new Error(`--start ${start} is after --end ${end}`)
  return {
    station,
    // Placeholders resolved against the station timezone once it's loaded.
    start: start ?? '',
    end: end ?? '',
    verify: argv.includes('--verify'),
    out: get('--out') ?? 'reports',
  }
}

async function resolveStation(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, timezone')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(`Failed to load station "${slug}": ${error.message}`)
  if (!data) throw new Error(`No station with slug "${slug}"`)
  return data as { id: string; slug: string; name: string; timezone: string | null }
}

/**
 * Load the expected-side data from the CMS tables (read-only). The CMS keeps its
 * own station rows — join by slug. Prefers the concrete per-date published
 * schedule when rows exist for the window; otherwise falls back to the recurring
 * weekly grid (the published table is empty today, but if the CMS starts
 * publishing, per-date rows are strictly better — they capture one-off changes).
 */
async function loadSchedule(slug: string, start: string, end: string) {
  const { data: cmsStation, error: stErr } = await supabaseAdmin
    .from('cms_stations')
    .select('id, slug')
    .eq('slug', slug)
    .maybeSingle()
  if (stErr) throw new Error(`Failed to load cms_stations: ${stErr.message}`)
  if (!cmsStation) {
    throw new Error(
      `No CMS station with slug "${slug}" — the expected schedule comes from the CMS app's tables, ` +
        `so this station can't be verified until it exists there.`
    )
  }

  const { data: showRows, error: shErr } = await supabaseAdmin
    .from('cms_shows')
    .select('id, title, program_slug')
    .eq('station_id', cmsStation.id)
    .limit(2000)
  if (shErr) throw new Error(`Failed to load cms_shows: ${shErr.message}`)
  const showsById = new Map<string, CmsShow>(
    (showRows ?? []).map((s) => [s.id as string, { id: s.id, title: s.title, programSlug: s.program_slug }])
  )

  const { data: sourceRows, error: srcErr } = await supabaseAdmin
    .from('cms_show_source')
    .select('qir_show_key, cms_show_id')
    .eq('station_id', cmsStation.id)
    .not('qir_show_key', 'is', null)
    .not('cms_show_id', 'is', null)
    .limit(2000)
  if (srcErr) throw new Error(`Failed to load cms_show_source: ${srcErr.message}`)
  const keysByShowId = new Map<string, string[]>()
  for (const row of sourceRows ?? []) {
    const list = keysByShowId.get(row.cms_show_id) ?? []
    list.push(row.qir_show_key)
    keysByShowId.set(row.cms_show_id, list)
  }

  // Per-date published rows for the window, if the CMS has published any.
  const { data: published, error: pubErr } = await supabaseAdmin
    .from('cms_schedule_published')
    .select('air_date, start_time, end_time, show_id, label')
    .eq('station_id', cmsStation.id)
    .gte('air_date', start)
    .lte('air_date', end)
    .limit(2000)
  if (pubErr) throw new Error(`Failed to load cms_schedule_published: ${pubErr.message}`)

  const { data: slotRows, error: slErr } = await supabaseAdmin
    .from('cms_schedule_slots')
    .select('day_of_week, start_time, end_time, show_id, label, effective_date, expires_date')
    .eq('station_id', cmsStation.id)
    .limit(2000)
  if (slErr) throw new Error(`Failed to load cms_schedule_slots: ${slErr.message}`)
  const slots: ScheduleSlot[] = (slotRows ?? []).map((s) => ({
    dayOfWeek: s.day_of_week,
    startTime: s.start_time,
    endTime: s.end_time,
    showId: s.show_id,
    label: s.label,
    effectiveDate: s.effective_date,
    expiresDate: s.expires_date,
  }))
  if (!slots.length && !published?.length) {
    throw new Error(`CMS has no schedule for "${slug}" (cms_schedule_slots and cms_schedule_published are empty)`)
  }

  // Published rows become date-pinned "slots" so expandBlocks treats both
  // sources identically (day_of_week recomputed from the date).
  const publishedByDate = new Map<string, ScheduleSlot[]>()
  for (const p of published ?? []) {
    const list = publishedByDate.get(p.air_date) ?? []
    list.push({
      dayOfWeek: weekdayOf(p.air_date),
      startTime: p.start_time,
      endTime: p.end_time,
      showId: p.show_id,
      label: p.label,
      effectiveDate: p.air_date,
      expiresDate: p.air_date,
    })
    publishedByDate.set(p.air_date, list)
  }

  const slotsForDate = (date: string): ScheduleSlot[] => publishedByDate.get(date) ?? slots
  const scheduleSource = (date: string): 'published' | 'recurring' =>
    publishedByDate.has(date) ? 'published' : 'recurring'

  return { showsById, keysByShowId, slotsForDate, scheduleSource }
}

/** QIR's own show registry — drives show_group key expansion + the
 *  tracked/untracked distinction (see lib/verify-week.ts#enrichBlocks). */
async function loadQirShows(stationId: string): Promise<QirShowKeyInfo[]> {
  const { data, error } = await supabaseAdmin
    .from('show_keys')
    .select('key, show_group, show_name, feed_name, display_name, active')
    .eq('station_id', stationId)
    .is('archived_at', null)
    .limit(2000)
  if (error) throw new Error(`Failed to load show_keys: ${error.message}`)
  return (data ?? []).map((r) => ({
    key: r.key,
    showGroup: r.show_group,
    showName: r.display_name ?? r.feed_name ?? r.show_name,
    active: r.active,
  }))
}

async function loadAirings(stationId: string, start: string, end: string) {
  const { data, error } = await supabaseAdmin
    .from('episode_log')
    .select('id, show_key, show_name, host, guest, air_date, air_start, air_end, duration, status')
    .eq('station_id', stationId)
    .gte('air_date', start)
    .lte('air_date', end)
    .order('air_date')
    .order('air_start')
    .limit(3000)
  if (error) throw new Error(`Failed to load episodes: ${error.message}`)
  const rows = data ?? []
  if (rows.length === 3000) console.warn('[verify-week] episode query hit its 3000-row cap — window too large?')

  const ids = rows.map((r) => r.id)
  const withTranscript = new Set<number>()
  // Chunk the IN() list — a week is ~200 episodes, but keep the URL bounded.
  for (let i = 0; i < ids.length; i += 400) {
    const { data: t, error: tErr } = await supabaseAdmin
      .from('transcripts')
      .select('episode_id')
      .in('episode_id', ids.slice(i, i + 400))
    if (tErr) throw new Error(`Failed to load transcript index: ${tErr.message}`)
    for (const row of t ?? []) withTranscript.add(row.episode_id)
  }

  const airings: Airing[] = rows.map((r) => ({
    episodeId: r.id,
    showKey: r.show_key,
    showName: r.show_name,
    airDate: r.air_date,
    airStart: r.air_start,
    airEnd: r.air_end,
    durationMin: r.duration,
    status: r.status,
    hasTranscript: withTranscript.has(r.id),
  }))
  const meta = new Map(rows.map((r) => [r.id, { host: r.host as string | null, guest: r.guest as string | null }]))
  return { airings, meta }
}

function findPipelineIssues(airings: Airing[], quarterStart: string): PipelineIssue[] {
  const issues: PipelineIssue[] = []
  for (const a of airings) {
    const base = {
      episodeId: a.episodeId,
      showName: a.showName,
      airDate: a.airDate,
      airStart: a.airStart,
      status: a.status,
    }
    if (a.status === 'pending' && a.airDate < quarterStart) {
      issues.push({
        ...base,
        issue: 'stuck pending behind the current-quarter gate — run backfill-quarter --kick for its quarter',
      })
    } else if (['failed', 'dead', 'unavailable', 'transcript_missing'].includes(a.status)) {
      issues.push({ ...base, issue: `status ${a.status}` })
    } else if (!a.hasTranscript && !['pending', 'transcribing'].includes(a.status)) {
      issues.push({ ...base, issue: `no transcript despite status ${a.status}` })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Layer 2 — AI content verification
// ---------------------------------------------------------------------------

const VERIFY_SYSTEM_PROMPT = `You verify radio broadcast logs against transcripts for a public radio station. Given the claimed show metadata and a transcript excerpt, judge whether the content supports the claim.

Consider: Does the content, style, and any on-air identification match the claimed show? Are there signs it is a RERUN (outdated date references, "originally aired", stale news treated as current)? A PLEDGE DRIVE or fundraiser special? A DIFFERENT PROGRAM than claimed? A TECHNICAL ISSUE (dead air, looping, garbled content)?

Respond with JSON only:
{"consistent": true|false, "content_type": "regular"|"rerun"|"pledge_drive"|"different_program"|"technical_issue"|"unclear", "confidence": "high"|"medium"|"low", "evidence": "one or two sentences citing what in the transcript supports your judgment"}

"consistent" means the transcript plausibly is the claimed show airing as normal programming. A rerun of the correct show is consistent=true with content_type "rerun". Be conservative: prefer "unclear" with low confidence over guessing.`

/** Head + tail excerpt — the head carries the show intro/IDs, the tail catches
 *  sign-offs and next-episode teasers that expose reruns. */
function excerptTranscript(text: string, headChars = 12000, tailChars = 4000): string {
  if (text.length <= headChars + tailChars) return text
  return `${text.slice(0, headChars)}\n[... middle omitted ...]\n${text.slice(-tailChars)}`
}

async function aiVerifyEpisode(
  openai: OpenAI,
  claim: { showTitle: string; host: string | null; guest: string | null; airDate: string; airStart: string | null; stationName: string },
  transcript: string
): Promise<{ verdict: AiVerdict; inputTokens: number; outputTokens: number }> {
  const user = [
    `Station: ${claim.stationName}`,
    `Claimed show: ${claim.showTitle}`,
    claim.host ? `Claimed host: ${claim.host}` : null,
    claim.guest ? `Logged guest: ${claim.guest}` : null,
    `Air date/time: ${claim.airDate} ${claim.airStart ?? '(time unknown)'} (${WEEKDAYS[weekdayOf(claim.airDate)]})`,
    '',
    'Transcript excerpt:',
    excerptTranscript(transcript),
  ]
    .filter((l) => l !== null)
    .join('\n')

  let response: OpenAI.Chat.Completions.ChatCompletion | null = null
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: VERIFY_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      })
      break
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const status = (err as { status?: number })?.status
      if (status && [429, 500, 502, 503].includes(status)) {
        const delay = Math.pow(2, attempt + 1) * 1000
        console.warn(`[verify-week] OpenAI error ${status}, retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  if (!response) throw lastError ?? new Error('OpenAI verification failed after retries')

  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const fallback: AiVerdict = { consistent: true, content_type: 'unclear', confidence: 'low', evidence: 'Model returned unparseable output.' }
  const content = response.choices[0]?.message?.content
  if (!content) return { verdict: fallback, inputTokens, outputTokens }
  try {
    const parsed = JSON.parse(content) as Partial<AiVerdict>
    return {
      verdict: {
        consistent: parsed.consistent !== false,
        content_type: parsed.content_type ?? 'unclear',
        confidence: parsed.confidence ?? 'low',
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence.slice(0, 500) : '',
      },
      inputTokens,
      outputTokens,
    }
  } catch {
    return { verdict: fallback, inputTokens, outputTokens }
  }
}

/** Bounded-concurrency map (order-preserving); a rejection surfaces as null. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (err) {
        console.warn(`[verify-week] AI check failed for item ${i}:`, err instanceof Error ? err.message : err)
      }
    }
  })
  await Promise.all(workers)
  return results
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

interface ReportData {
  station: { slug: string; name: string }
  window: { start: string; end: string }
  generatedAt: string
  scheduleSourceByDate: Record<string, 'published' | 'recurring'>
  days: DayReport[]
  pipelineIssues: PipelineIssue[]
  aiVerdicts: Record<number, AiVerdict> // by episodeId; empty without --verify
  aiRan: boolean
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function renderMarkdown(r: ReportData): string {
  const allBlocks = r.days.flatMap((d) => d.blocks)
  const tracked = allBlocks.filter((b) => b.tracked)
  const aired = tracked.filter((b) => b.verdict === 'aired').length
  const partial = tracked.filter((b) => b.verdict === 'partial').length
  const missing = tracked.filter((b) => b.verdict === 'missing').length
  const untracked = allBlocks.length - tracked.length
  const unscheduled = r.days.reduce((n, d) => n + d.unscheduled.length, 0)
  const aiFlagged = Object.entries(r.aiVerdicts).filter(
    ([, v]) => !v.consistent || !['regular', 'unclear'].includes(v.content_type)
  )

  const lines: string[] = []
  lines.push(`# Broadcast verification — ${r.station.name}`)
  lines.push('')
  lines.push(`Window **${r.window.start} .. ${r.window.end}** · generated ${r.generatedAt}`)
  lines.push('')
  lines.push('This is a review aid, not a pass/fail: preemptions and specials are legitimate — a human decides what is actually wrong.')
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Expected blocks: **${allBlocks.length}** — aired ${aired} (${pct(tracked.length ? aired / tracked.length : 0)} of tracked), partial ${partial}, missing ${missing}, not tracked by QIR ${untracked}`)
  lines.push(`- Unscheduled airings: **${unscheduled}**`)
  lines.push(`- Pipeline issues: **${r.pipelineIssues.length}**`)
  lines.push(
    r.aiRan
      ? `- AI transcript check: ran — **${aiFlagged.length}** flagged of ${Object.keys(r.aiVerdicts).length} checked`
      : '- AI transcript check: skipped (pass --verify to content-check transcripts)'
  )
  lines.push('')

  const attention: string[] = []
  for (const day of r.days) {
    for (const b of day.blocks) {
      if (!b.tracked) continue // QIR never records these shows — not a broadcast finding
      if (b.verdict === 'missing') attention.push(`${day.date} ${minToTime(b.startMin)}–${minToTime(b.endMin)} **${b.showTitle}** — nothing matching aired`)
      else if (b.verdict === 'partial') attention.push(`${day.date} ${minToTime(b.startMin)}–${minToTime(b.endMin)} **${b.showTitle}** — only ${pct(b.coverage)} covered`)
    }
    for (const u of day.unscheduled) {
      const displaced = u.displaced.length ? ` (displacing ${u.displaced.map((d) => d.showTitle).join(', ')})` : ''
      attention.push(`${day.date} ${minToTime(u.startMin)}–${minToTime(u.endMin)} unscheduled **${u.airing.showName ?? u.airing.showKey}**${displaced}`)
    }
  }
  for (const [id, v] of aiFlagged) {
    attention.push(`episode ${id}: AI says ${v.content_type.replace('_', ' ')} (${v.confidence} confidence) — ${v.evidence}`)
  }
  for (const p of r.pipelineIssues) {
    attention.push(`${p.airDate} ${p.showName ?? ''} (episode ${p.episodeId}) — ${p.issue}`)
  }
  if (attention.length) {
    lines.push('## Needs attention')
    lines.push('')
    for (const a of attention) lines.push(`- ${a}`)
    lines.push('')
  }

  for (const day of r.days) {
    lines.push(`## ${WEEKDAYS[weekdayOf(day.date)]} ${day.date}`)
    lines.push('')
    lines.push(`Schedule source: ${r.scheduleSourceByDate[day.date]}`)
    lines.push('')
    lines.push('| Time | Expected | Verdict | Aired as | AI check |')
    lines.push('|------|----------|---------|----------|----------|')
    for (const b of day.blocks) {
      const time = `${minToTime(b.startMin)}–${minToTime(b.endMin)}`
      const verdict =
        b.verdict === 'aired'
          ? '✅ aired'
          : b.verdict === 'partial'
            ? `⚠️ partial (${pct(b.coverage)})`
            : b.tracked
              ? '❌ missing'
              : '◽ not tracked'
      const airedAs = b.airings
        .map((a) => `${a.showName ?? a.showKey} ${minToTime(a.startMin)}–${minToTime(a.endMin)} (#${a.episodeId})`)
        .join('<br>')
      const ai = b.airings
        .map((a) => {
          const v = r.aiVerdicts[a.episodeId]
          if (!v) return r.aiRan ? '–' : ''
          const flag = v.consistent && ['regular', 'unclear'].includes(v.content_type) ? '✅' : '🚩'
          return `${flag} ${v.content_type.replace('_', ' ')} (${v.confidence})`
        })
        .join('<br>')
      lines.push(`| ${time} | ${b.showTitle} | ${verdict} | ${airedAs || '—'} | ${ai || '—'} |`)
    }
    lines.push('')
    if (day.unscheduled.length) {
      lines.push('**Unscheduled airings:**')
      lines.push('')
      for (const u of day.unscheduled) {
        const v = r.aiVerdicts[u.airing.episodeId]
        const ai = v ? ` — AI: ${v.content_type.replace('_', ' ')} (${v.confidence}): ${v.evidence}` : ''
        const displaced = u.displaced.length ? ` in place of ${u.displaced.map((d) => d.showTitle).join(', ')}` : ''
        lines.push(`- ${minToTime(u.startMin)}–${minToTime(u.endMin)} **${u.airing.showName ?? u.airing.showKey}** (#${u.airing.episodeId}, status ${u.airing.status})${displaced}${ai}`)
      }
      lines.push('')
    }
    if (day.unplaced.length) {
      lines.push(`**Unplaceable (no air_start):** ${day.unplaced.map((a) => `${a.showName ?? a.showKey} (#${a.episodeId})`).join(', ')}`)
      lines.push('')
    }
  }

  if (r.pipelineIssues.length) {
    lines.push('## Pipeline issues')
    lines.push('')
    lines.push('| Date | Show | Episode | Status | Issue |')
    lines.push('|------|------|---------|--------|-------|')
    for (const p of r.pipelineIssues) {
      lines.push(`| ${p.airDate} | ${p.showName ?? ''} | #${p.episodeId} | ${p.status} | ${p.issue} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const station = await resolveStation(args.station)
  const tz = station.timezone ?? 'America/Los_Angeles'
  // Default window: the last 7 complete station-local days (ending yesterday).
  const end = args.end || localDate(tz, 1)
  const start = args.start || localDate(tz, 7)
  console.log(`[verify-week] ${station.name} — ${start} .. ${end}${args.verify ? ' (with AI transcript check)' : ''}`)

  const schedule = await loadSchedule(station.slug, start, end)
  const qirShows = await loadQirShows(station.id)
  const { airings, meta } = await loadAirings(station.id, start, end)
  console.log(`[verify-week] ${airings.length} logged airings, ${airings.filter((a) => a.hasTranscript).length} with transcripts`)

  const dates = datesInWindow(start, end)
  const scheduleSourceByDate: Record<string, 'published' | 'recurring'> = {}
  const days: DayReport[] = dates.map((date) => {
    scheduleSourceByDate[date] = schedule.scheduleSource(date)
    const blocks = enrichBlocks(
      expandBlocks(schedule.slotsForDate(date), schedule.showsById, schedule.keysByShowId, date),
      qirShows
    )
    return reconcileDay(date, blocks, airings.filter((a) => a.airDate === date))
  })

  const pipelineIssues = findPipelineIssues(airings, currentQuarterStart(tz))

  // Layer 2: content-check every transcript-bearing airing (matched, unscheduled,
  // or unplaced — each still claims to be a specific show).
  const aiVerdicts: Record<number, AiVerdict> = {}
  if (args.verify) {
    const openaiKey = process.env.OPENAI_API_KEY
    if (!openaiKey) throw new Error('--verify needs OPENAI_API_KEY in the environment')
    const openai = new OpenAI({ apiKey: openaiKey, timeout: 5 * 60 * 1000 })

    const targets = airings.filter((a) => a.hasTranscript)
    console.log(`[verify-week] AI-checking ${targets.length} transcripts...`)
    let done = 0
    await mapPool(targets, 4, async (a) => {
      const { data: t, error } = await supabaseAdmin
        .from('transcripts')
        .select('transcript')
        .eq('episode_id', a.episodeId)
        .maybeSingle()
      if (error || !t?.transcript) return null
      const m = meta.get(a.episodeId)
      const { verdict, inputTokens, outputTokens } = await aiVerifyEpisode(
        openai,
        {
          showTitle: a.showName ?? a.showKey,
          host: m?.host ?? null,
          guest: m?.guest ?? null,
          airDate: a.airDate,
          airStart: a.airStart,
          stationName: station.name,
        },
        t.transcript
      )
      aiVerdicts[a.episodeId] = verdict
      if (inputTokens > 0) {
        await logVerificationUsage(station.id, a.episodeId, inputTokens, outputTokens, {
          job: 'verify-week',
          window: { start, end },
          content_type: verdict.content_type,
          consistent: verdict.consistent,
        })
      }
      done++
      if (done % 25 === 0) console.log(`[verify-week]   ${done}/${targets.length}`)
      return verdict
    })
    console.log(`[verify-week] AI check complete (${Object.keys(aiVerdicts).length}/${targets.length} verdicts)`)
  }

  const report: ReportData = {
    station: { slug: station.slug, name: station.name },
    window: { start, end },
    generatedAt: new Date().toISOString(),
    scheduleSourceByDate,
    days,
    pipelineIssues,
    aiVerdicts,
    aiRan: args.verify,
  }

  await fs.mkdir(args.out, { recursive: true })
  const base = path.join(args.out, `verify-week-${station.slug}-${start}-to-${end}`)
  await fs.writeFile(`${base}.md`, renderMarkdown(report))
  await fs.writeFile(`${base}.json`, JSON.stringify(report, null, 2))

  // Terminal summary — one line per day.
  console.log('')
  for (const day of days) {
    const t = day.blocks.filter((b) => b.tracked)
    const aired = t.filter((b) => b.verdict === 'aired').length
    const partial = t.filter((b) => b.verdict === 'partial').length
    const missing = t.filter((b) => b.verdict === 'missing').length
    const untracked = day.blocks.length - t.length
    console.log(
      `  ${WEEKDAYS[weekdayOf(day.date)].padEnd(9)} ${day.date}  blocks ${String(day.blocks.length).padStart(2)}: ` +
        `${aired} aired, ${partial} partial, ${missing} missing, ${untracked} untracked · ${day.unscheduled.length} unscheduled`
    )
  }
  const flagged = Object.values(aiVerdicts).filter((v) => !v.consistent || !['regular', 'unclear'].includes(v.content_type)).length
  if (args.verify) console.log(`  AI transcript check: ${flagged} flagged of ${Object.keys(aiVerdicts).length}`)
  if (pipelineIssues.length) console.log(`  Pipeline issues: ${pipelineIssues.length} (see report)`)
  console.log(`\n[verify-week] report: ${base}.md`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[verify-week] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
