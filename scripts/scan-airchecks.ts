/**
 * Aircheck scan: are hosts identifying the station at the top and bottom of the
 * hour, running promos, and starting/stopping cleanly on the slot boundaries?
 *
 * Built for the 8pm-midnight block, but the window is a flag — it scans any
 * daypart. Three things get reported, all off the timed captions:
 *
 *   1. Station ID at each :00 / :30 mark. The archive slices recordings on the
 *      hour and half-hour, so a file's own head IS a boundary. Cues are mapped
 *      to absolute wall-clock time and merged per stream, so an ID given by the
 *      outgoing host at 20:29:40 correctly satisfies the 20:30 mark even though
 *      it lands in the previous file. IDs are graded: a full legal ID (call sign
 *      + community of license) vs. a bare call sign vs. frequency only.
 *   2. Promos per hour — tune-ins, membership, underwriting, stream plugs, in
 *      English and Spanish (the evening block is majority Spanish-language).
 *      The lexical pass is a FLOOR on how much promo ran; --verify adds a
 *      gpt-4o-mini judgment pass over the hours that look empty.
 *   3. Start/stop hygiene — late starts, cold opens mid-sentence, the previous
 *      programme still signing off inside this file, dead air at the tail, and
 *      shows still talking when the file cuts.
 *
 *   npm run scan-airchecks -- --station kpfk                        # last 14 days, 20:00-24:00
 *   npm run scan-airchecks -- --station kpfk --start 20:00 --end 24:00
 *   npm run scan-airchecks -- --station kpfk --from 2026-07-01 --to 2026-07-31
 *   npm run scan-airchecks -- --station kpfk --verify               # + AI promo check
 *
 * Output: summary to stdout + markdown/JSON reports in --out (default reports/).
 * This is a review aid, not a pass/fail. Transcription is imperfect, music
 * programming yields sparse captions, and a legal ID can be carried by a station
 * cart the captions render oddly — a human confirms before anyone is told off.
 *
 * Requirements: worker env (SUPABASE service role; OPENAI_API_KEY for --verify).
 * Read-only apart from usage_log (--verify only) and one audit_log row.
 */
import OpenAI from 'openai'
import * as fs from 'fs/promises'
import * as path from 'path'
import { supabaseAdmin } from '../lib/supabase'
import { logVerificationUsage } from '../lib/usage'
import { isStationOverBudget, isUniversalOverBudget } from '../lib/settings'
import { isSpendLimitError } from '../lib/retry-policy'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { parseVtt } from '../lib/vtt'
import {
  DEFAULT_AIRCHECK_CONFIG,
  datesInRange,
  scanStreamNight,
  secToClock,
  timeToSec,
  type AircheckConfig,
  streamOf,
  cityFromStationName,
  type AircheckEpisode,
  type Cue,
  type StreamNightScan,
} from '../lib/aircheck'
import {
  ISSUE_LABELS,
  isMiss,
  renderMarkdown,
  scannable,
  showScorecard,
  type AiPromoVerdict,
  type ReportData,
} from '../lib/aircheck-report'

interface Args {
  station: string
  from: string
  to: string
  slotStart: string
  slotEnd: string
  verify: boolean
  out: string
  noBottom: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  if (!station) {
    throw new Error(
      'Usage: tsx scripts/scan-airchecks.ts --station <slug> [--from YYYY-MM-DD --to YYYY-MM-DD] ' +
        '[--start HH:MM --end HH:MM] [--verify] [--no-bottom] [--out <dir>]'
    )
  }
  const from = get('--from')
  const to = get('--to')
  if ((from && !to) || (!from && to)) throw new Error('--from and --to must be given together')
  if (from && to && from > to) throw new Error(`--from ${from} is after --to ${to}`)
  return {
    station,
    from: from ?? '',
    to: to ?? '',
    slotStart: get('--start') ?? '20:00',
    slotEnd: get('--end') ?? '24:00',
    verify: argv.includes('--verify'),
    noBottom: argv.includes('--no-bottom'),
    out: get('--out') ?? 'reports',
  }
}

/** Today's date in the station's timezone (air_date is station-local). */
function localDate(timeZone: string, daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(d)
}

/**
 * Fetch every row of a query, paging with .range(). PostgREST silently caps a
 * response at the server's max-rows even when .limit() asks for more, so a
 * plain capped select would truncate a long window with no error.
 */
async function fetchAllRows<T>(
  context: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 500
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${context}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) return rows
  }
}

async function resolveStation(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, timezone, station_id_patterns, mp3_filename_prefix')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(`Failed to load station "${slug}": ${error.message}`)
  if (!data) throw new Error(`No station with slug "${slug}"`)
  return data as {
    id: string
    slug: string
    name: string
    timezone: string | null
    station_id_patterns: string[] | null
    mp3_filename_prefix: string | null
  }
}

// ---------------------------------------------------------------------------
// AI promo check (--verify)
// ---------------------------------------------------------------------------

const PROMO_PROMPT = `You review radio broadcast transcripts for {{STATION_NAME}}.
You are given one hour of transcript from a single programme.
Decide whether the hour contains any PROMOTIONAL station content, meaning any of:
 - promos or tune-in spots for other programmes on this station
 - membership, pledge, fund-drive or donation appeals
 - underwriting or sponsor credits
 - plugs for the station's website, app, archive, podcast or live stream
Do NOT count: the host merely naming their own show, ordinary interview or news
content, or music. Transcripts may be in Spanish or English.
Respond with JSON only:
{"promos_present": boolean, "kinds": string[], "confidence": "high"|"medium"|"low", "evidence": "<short quote or empty>"}`

async function aiCheckPromos(
  openai: OpenAI,
  stationName: string,
  text: string
): Promise<{ verdict: AiPromoVerdict; inputTokens: number; outputTokens: number }> {
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: PROMO_PROMPT.replace('{{STATION_NAME}}', stationName) },
      { role: 'user', content: text.slice(0, 14000) },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' },
  })
  const content = res.choices[0]?.message?.content ?? '{}'
  let parsed: Partial<AiPromoVerdict> = {}
  try {
    parsed = JSON.parse(content)
  } catch {
    /* fall through to the default verdict below */
  }
  return {
    verdict: {
      promos_present: parsed.promos_present ?? false,
      kinds: Array.isArray(parsed.kinds) ? parsed.kinds : [],
      confidence: parsed.confidence ?? 'low',
      evidence: parsed.evidence ?? '',
    },
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const station = await resolveStation(args.station)
  const tz = station.timezone ?? 'America/Los_Angeles'
  const to = args.to || localDate(tz)
  const from = args.from || localDate(tz, 13)

  const slotStartSec = timeToSec(args.slotStart.length === 5 ? `${args.slotStart}:00` : args.slotStart)
  const slotEndSec = timeToSec(args.slotEnd === '24:00' ? '23:59:59' : args.slotEnd.length === 5 ? `${args.slotEnd}:00` : args.slotEnd)

  const cfg: AircheckConfig = {
    ...DEFAULT_AIRCHECK_CONFIG,
    idPatterns: [...(station.station_id_patterns ?? []), 'noventa punto siete'],
    cityNames: cityFromStationName(station.name),
    checkBottomOfHour: !args.noBottom,
  }

  console.log(
    `[aircheck] ${station.slug} ${args.slotStart}-${args.slotEnd}, ${from} → ${to}` +
      `${args.verify ? ' (+AI promo check)' : ''}`
  )

  // --- Load episodes in the daypart ---
  const episodeRows = await fetchAllRows<{
    id: number
    show_key: string
    show_name: string | null
    category: string | null
    air_date: string
    air_start: string | null
    duration: number | null
    mp3_url: string | null
  }>('episode_log', (lo, hi) =>
    supabaseAdmin
      .from('episode_log')
      .select('id, show_key, show_name, category, air_date, air_start, duration, mp3_url')
      .eq('station_id', station.id)
      .gte('air_date', from)
      .lte('air_date', to)
      .gte('air_start', args.slotStart.length === 5 ? `${args.slotStart}:00` : args.slotStart)
      .lte('air_start', secToClock(slotEndSec) + ':59')
      .order('air_date')
      .order('air_start')
      .range(lo, hi)
  )

  if (!episodeRows.length) {
    console.log('[aircheck] no episodes in that daypart/window — nothing to scan')
    process.exit(0)
  }

  const noAirStart = episodeRows.filter((e) => !e.air_start).length

  // --- Load captions: prefer the cue table, fall back to parsing the VTT ---
  const ids = episodeRows.map((e) => e.id)
  const cuesByEpisode = new Map<number, Cue[]>()

  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const rows = await fetchAllRows<{ episode_id: number; start_ms: number; end_ms: number; text: string }>(
      'transcript_cues',
      (lo, hi) =>
        supabaseAdmin
          .from('transcript_cues')
          .select('episode_id, start_ms, end_ms, text')
          .in('episode_id', chunk)
          .order('episode_id')
          .order('cue_idx')
          .range(lo, hi),
      1000
    )
    for (const row of rows) {
      const list = cuesByEpisode.get(row.episode_id) ?? []
      list.push({ startMs: row.start_ms, endMs: row.end_ms, text: row.text })
      cuesByEpisode.set(row.episode_id, list)
    }
  }

  // Episodes the cue table doesn't cover — parse their VTT directly so a file
  // that predates the cue backfill still gets scanned.
  const missing = ids.filter((id) => !cuesByEpisode.has(id))
  if (missing.length) {
    console.log(`[aircheck] ${missing.length} file(s) without cue rows — parsing VTT directly`)
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50)
      const { data } = await supabaseAdmin.from('transcripts').select('episode_id, vtt').in('episode_id', chunk)
      for (const row of data ?? []) {
        const cues = parseVtt(row.vtt).map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }))
        if (cues.length) cuesByEpisode.set(row.episode_id, cues)
      }
    }
  }

  const noCaptions = episodeRows.filter((e) => e.air_start && !cuesByEpisode.has(e.id)).length

  // --- Scan, per date and per stream ---
  const episodes: AircheckEpisode[] = episodeRows.map((e) => ({
    episodeId: e.id,
    showKey: e.show_key,
    showName: e.show_name,
    category: e.category,
    airDate: e.air_date,
    airStart: e.air_start,
    durationMin: e.duration,
    stream: streamOf(e.mp3_url, station.mp3_filename_prefix),
  }))

  const nights: StreamNightScan[] = []
  for (const date of datesInRange(from, to)) {
    const forDate = episodes.filter((e) => e.airDate === date)
    if (!forDate.length) continue
    for (const stream of Array.from(new Set(forDate.map((e) => e.stream))).sort()) {
      const forStream = forDate.filter((e) => e.stream === stream)
      const scan = scanStreamNight(date, stream, forStream, cuesByEpisode, cfg)
      if (scan.episodes.length) nights.push(scan)
    }
  }

  // --- Optional AI promo check over the files with no lexical promo hit ---
  const aiVerdicts: Record<string, AiPromoVerdict> = {}
  let aiRan = false
  if (args.verify) {
    const overBudget = (await isUniversalOverBudget()) || (await isStationOverBudget(station.id))
    const key = process.env.OPENAI_API_KEY
    if (overBudget) {
      console.warn('[aircheck] spend limit reached — skipping AI promo check')
    } else if (!key) {
      console.warn('[aircheck] OPENAI_API_KEY not set — skipping AI promo check')
    } else {
      const openai = new OpenAI({ apiKey: key, timeout: 3 * 60 * 1000 })
      const targets = nights.flatMap((n) => n.episodes.filter((e) => e.promos.length === 0 && e.cueCount > 0))
      console.log(`[aircheck] AI promo check on ${targets.length} file(s) with no lexical promo hit...`)
      aiRan = true
      let aborted = false
      let done = 0
      for (const t of targets) {
        if (aborted) break
        const cues = cuesByEpisode.get(t.episode.episodeId) ?? []
        const text = cues.map((c) => c.text).join(' ')
        if (!text.trim()) continue
        try {
          const { verdict, inputTokens, outputTokens } = await aiCheckPromos(openai, station.name, text)
          aiVerdicts[String(t.episode.episodeId)] = verdict
          if (inputTokens > 0) {
            await logVerificationUsage(station.id, t.episode.episodeId, inputTokens, outputTokens, {
              job: 'scan-airchecks',
              window: { from, to },
              promos_present: verdict.promos_present,
            })
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (isSpendLimitError(msg)) {
            console.warn('[aircheck] spend limit hit mid-run — aborting remaining AI checks')
            aborted = true
          } else {
            console.warn(`[aircheck] AI check failed for episode ${t.episode.episodeId}: ${msg}`)
          }
        }
        if (++done % 25 === 0) console.log(`[aircheck]   ${done}/${targets.length}`)
      }
    }
  }

  const report: ReportData = {
    station: { slug: station.slug, name: station.name },
    window: { from, to, slotStart: args.slotStart, slotEnd: args.slotEnd },
    generatedAt: new Date().toISOString(),
    nights,
    aiVerdicts,
    aiRan,
    skipped: { noCaptions, noAirStart },
  }

  await fs.mkdir(args.out, { recursive: true })
  const base = path.join(args.out, `aircheck-${station.slug}-${from}-to-${to}`)
  await fs.writeFile(`${base}.md`, renderMarkdown(report))
  await fs.writeFile(`${base}.json`, JSON.stringify(report, null, 2))

  // --- Terminal summary ---
  const all = nights.flatMap((n) => n.boundaries)
  const tops = all.filter((b) => b.kind === 'top')
  const bottoms = all.filter((b) => b.kind === 'bottom')
  const noneTop = tops.filter(isMiss).length
  const noneBottom = bottoms.filter(isMiss).length
  const scorableTop = scannable(tops).length
  const scorableBottom = scannable(bottoms).length
  const files = nights.reduce((n, x) => n + x.episodes.length, 0)

  console.log('')
  console.log(`  Files scanned:       ${files}`)
  console.log(
    `  Top of hour  (:00):  ${scorableTop} scorable of ${tops.length} — ${noneTop} with NO station ID ` +
      `(${scorableTop ? Math.round((noneTop / scorableTop) * 100) : 0}%)`
  )
  if (bottoms.length) {
    console.log(
      `  Bottom of hour(:30): ${scorableBottom} scorable of ${bottoms.length} — ${noneBottom} with NO station ID ` +
        `(${scorableBottom ? Math.round((noneBottom / scorableBottom) * 100) : 0}%)`
    )
  }
  console.log('')
  console.log('  Worst shows by missing station ID:')
  for (const s of showScorecard(nights).slice(0, 8)) {
    console.log(
      `    ${s.name.slice(0, 42).padEnd(44)} ${String(s.none).padStart(3)}/${String(s.scored).padEnd(3)} missing  [${s.stream}]`
    )
  }
  console.log('')
  const edgeCounts = new Map<string, number>()
  for (const n of nights) for (const e of n.episodes) for (const f of e.edges) {
    edgeCounts.set(f.issue, (edgeCounts.get(f.issue) ?? 0) + 1)
  }
  console.log('  Start/stop hygiene:')
  for (const [issue, label] of Object.entries(ISSUE_LABELS)) {
    const n = edgeCounts.get(issue) ?? 0
    if (n) console.log(`    ${label.padEnd(44)} ${String(n).padStart(3)} files`)
  }
  console.log(`\n[aircheck] report: ${base}.md`)

  // Bulk caption read + report export — leave an audit trail like the workers do.
  await logAuditEvent({
    action: AUDIT_ACTIONS.AIRCHECK_SCAN_COMPLETE,
    operation: 'export',
    stationId: station.id,
    resourceType: 'report',
    metadata: {
      window: { from, to },
      daypart: { start: args.slotStart, end: args.slotEnd },
      files,
      topMarks: tops.length,
      topScorable: scorableTop,
      topMissing: noneTop,
      bottomMarks: bottoms.length,
      bottomScorable: scorableBottom,
      bottomMissing: noneBottom,
      aiRan,
      aiChecked: Object.keys(aiVerdicts).length,
    },
  })
  process.exit(0)
}

main().catch((err) => {
  console.error('[aircheck] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
