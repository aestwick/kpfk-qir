/**
 * Fund-drive pitch analytics: which shows and hours carried pitches during a
 * drive, how many, and how long. Reads the timed cue surface (transcript_cues)
 * for every airing in the window, detects pitch segments (lib/pitch-report.ts),
 * and writes a per-show / per-hour / per-segment report.
 *
 *   npm run pitch-report -- --station kpfk --date 2026-07-31
 *   npm run pitch-report -- --station kpfk --start 2026-07-27 --end 2026-08-06
 *   npm run pitch-report -- --station kpfk --date 2026-07-31 --show hartmann
 *
 * Output: summary to stdout + markdown/CSV/JSON in --out (default reports/).
 * The segments CSV is one row per pitch (clock time, length, terms, excerpt) —
 * the shape development wants next to the donation log.
 *
 * This is the free, deterministic layer: it counts explicit asks (phone number,
 * donate URL, premiums, pledge language) and will under-report soft pitching
 * that never names an ask. Treat the numbers as a floor and spot-check the
 * excerpts; an AI pass over candidate regions is the intended second layer.
 *
 * Requirements: worker env (SUPABASE service role). Read-only apart from the
 * audit_log row it writes on completion. Costs nothing to run.
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import { supabaseAdmin } from '../lib/supabase'
import { getSetting } from '../lib/settings'
import { resolveShowDisplayName, resolveShowGroup } from '../lib/shows'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import {
  analyzeEpisode,
  buildReport,
  buildStationLexicon,
  formatDuration,
  renderAskersCsv,
  renderHoursCsv,
  renderMarkdown,
  renderSegmentsCsv,
  secToClock,
  type EpisodePitch,
  type PitchCue,
  type PitchEpisode,
} from '../lib/pitch-report'

interface Args {
  station: string
  start: string
  end: string
  show: string | null
  out: string
  json: boolean
}

/** Today's date in the station's timezone (air_date is station-local). */
function localDate(timeZone: string, daysAgo = 0): string {
  const d = new Date(Date.now() - daysAgo * 86400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }).format(d)
}

/**
 * Fetch every row of a query, paging with .range(). PostgREST caps a response at
 * the server's max-rows even when .limit() asks for more, so a plain select
 * would silently truncate a long window — and a truncated cue set reads as
 * "no pitches", which is the one wrong answer this report must never give.
 */
async function fetchAllRows<T>(
  context: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1)
    if (error) throw new Error(`Failed to load ${context}: ${error.message}`)
    rows.push(...(data ?? []))
    if (!data || data.length < pageSize) return rows
  }
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  if (!station) {
    throw new Error(
      'Usage: tsx scripts/pitch-report.ts --station <slug> [--date YYYY-MM-DD | --start YYYY-MM-DD --end YYYY-MM-DD] [--show <key>] [--out <dir>] [--json]'
    )
  }
  const date = get('--date')
  let start = get('--start')
  let end = get('--end')
  if (date) {
    if (start || end) throw new Error('--date cannot be combined with --start/--end')
    start = date
    end = date
  }
  if ((start && !end) || (!start && end)) throw new Error('--start and --end must be given together')
  if (start && end && start > end) throw new Error(`--start ${start} is after --end ${end}`)
  return {
    station,
    start: start ?? '', // resolved against the station timezone once it's loaded
    end: end ?? '',
    show: get('--show') ?? null,
    out: get('--out') ?? 'reports',
    json: argv.includes('--json'),
  }
}

async function resolveStation(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, timezone, show_name_strip_prefixes')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(`Failed to load station ${slug}: ${error.message}`)
  if (!data) throw new Error(`No station with slug "${slug}"`)
  return data
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const station = await resolveStation(args.station)
  const tz = station.timezone ?? 'America/Los_Angeles'
  const start = args.start || localDate(tz, 7)
  const end = args.end || localDate(tz, 1)

  // Show registry: show_group collapses the several feed keys a single logical
  // show airs under (the overnight strip logs six hourly keys), so per-show
  // totals aren't split six ways.
  const showRows = await fetchAllRows('show_keys', (from, to) =>
    supabaseAdmin
      .from('show_keys')
      .select('key, show_group, show_name, feed_name, display_name')
      .eq('station_id', station.id)
      .is('archived_at', null)
      .order('id')
      .range(from, to)
  )
  const showByKey = new Map(
    showRows.map((r: any) => [
      r.key,
      {
        group: resolveShowGroup(r),
        name: resolveShowDisplayName(r, station.show_name_strip_prefixes),
      },
    ])
  )

  let episodeRows = await fetchAllRows('episodes', (from, to) => {
    let q = supabaseAdmin
      .from('episode_log')
      .select('id, show_key, show_name, host, air_date, air_start, air_end, duration')
      .eq('station_id', station.id)
      .gte('air_date', start)
      .lte('air_date', end)
    if (args.show) q = q.eq('show_key', args.show)
    return q.order('air_date').order('air_start').range(from, to)
  })

  if (!episodeRows.length) {
    console.log(`No airings logged for ${station.slug} between ${start} and ${end}.`)
    process.exit(0)
  }

  const episodes: PitchEpisode[] = episodeRows.map((e: any) => {
    const show = showByKey.get(e.show_key)
    return {
      id: e.id,
      showKey: e.show_key,
      showGroup: show?.group ?? e.show_key,
      showName: show?.name ?? e.show_name,
      host: e.host,
      airDate: e.air_date,
      airStart: e.air_start,
      airEnd: e.air_end,
      durationMin: e.duration,
    }
  })

  // Cues for every airing in the window, in id-chunked pages (a long drive is
  // hundreds of thousands of rows; .in() lists have a URL-length ceiling).
  const cuesByEpisode = new Map<number, PitchCue[]>()
  const ids = episodes.map((e) => e.id)
  const CHUNK = 40
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const rows = await fetchAllRows('transcript_cues', (from, to) =>
      supabaseAdmin
        .from('transcript_cues')
        .select('episode_id, start_ms, end_ms, text')
        .in('episode_id', slice)
        .order('episode_id')
        .order('cue_idx')
        .range(from, to)
    )
    for (const r of rows as any[]) {
      const list = cuesByEpisode.get(r.episode_id) ?? []
      list.push({ startMs: r.start_ms, endMs: r.end_ms, text: r.text })
      cuesByEpisode.set(r.episode_id, list)
    }
    process.stderr.write(`\rloading cues… ${Math.min(i + CHUNK, ids.length)}/${ids.length} airings`)
  }
  process.stderr.write('\n')

  // Station-specific asks (a campaign URL, a shortcode, a premium name) can be
  // added per station without a deploy; the defaults cover the standard ask.
  const extraTerms = (await getSetting<string[]>('pitch_terms', station.id)) ?? []
  const lexicon = buildStationLexicon(station.slug, Array.isArray(extraTerms) ? extraTerms : [])

  const results: EpisodePitch[] = episodes.map((ep) =>
    analyzeEpisode(ep, cuesByEpisode.get(ep.id) ?? [], { lexicon })
  )
  const report = buildReport(
    { stationSlug: station.slug, stationName: station.name, start, end },
    results
  )

  // --- terminal summary -----------------------------------------------------
  const t = report.totals
  console.log(`\nPitch report — ${station.name}  ${start} → ${end}`)
  console.log(
    `${t.segmentCount} pitch segments, ${formatDuration(t.pitchMs)} of ${formatDuration(t.airtimeMs)} logged airtime (${(t.pitchRatio * 100).toFixed(1)}%)`
  )
  console.log(
    `${t.episodesWithPitch}/${t.episodes} airings had a pitch; ${t.episodes - t.episodesWithTranscript} airings have no transcript (counted as zero)`
  )

  const c = report.coverage
  console.log(
    `Coverage: ${c.hourSlotsLogged}/${c.hourSlots} hour-slots logged (${(c.ratio * 100).toFixed(1)}%) across ${c.daysInWindow} days — ${c.gaps.length} hours were never scanned`
  )

  console.log('\nBy hour (all 24, whether or not anything was logged)')
  for (const h of report.byHour) {
    const bar = '█'.repeat(Math.round(h.pitchRatio * 40))
    const gap = h.daysUnlogged ? `  ⚠ no airing on ${h.daysUnlogged}/${c.daysInWindow} days` : ''
    console.log(
      `  ${secToClock(h.hour * 3600)}  ${String(h.segmentCount).padStart(3)} pitches  ${formatDuration(h.pitchMs).padStart(8)}  ${(h.pitchRatio * 100).toFixed(1).padStart(5)}%  ${bar}${gap}`
    )
  }

  console.log(
    `\nAsk quality: ${t.complete} named phone+web, ${t.partial} named one, ${t.noChannel} named neither | ${t.withAmount} named an amount | ${t.sustainerAsks} sustainer | ${t.premiumAsks} premium`
  )

  console.log('\nWho asked, and for what')
  console.log(
    `  ${'show'.padEnd(30)} ${'host'.padEnd(18)} ${'n'.padStart(4)} ${'time'.padStart(8)} ${'mean'.padStart(6)} ${'ph+web'.padStart(7)} ${'$ask'.padStart(5)} ${'sust'.padStart(4)} usual`
  )
  for (const a of report.byAsker.slice(0, 20)) {
    if (!a.segmentCount) continue
    console.log(
      `  ${a.showName.slice(0, 30).padEnd(30)} ${(a.host ?? '—').slice(0, 18).padEnd(18)} ${String(a.segmentCount).padStart(4)} ${formatDuration(a.pitchMs).padStart(8)} ${formatDuration(a.meanSegmentMs).padStart(6)} ${`${a.complete}/${a.segmentCount}`.padStart(7)} ${String(a.withAmount).padStart(5)} ${String(a.sustainerAsks).padStart(4)} ${a.modalAmount ? `$${a.modalAmount}` : '—'}`
    )
  }

  // --- files ----------------------------------------------------------------
  await fs.mkdir(args.out, { recursive: true })
  const stem = path.join(args.out, `pitch-${station.slug}-${start}_${end}`)
  await fs.writeFile(`${stem}.md`, renderMarkdown(report))
  await fs.writeFile(`${stem}-segments.csv`, renderSegmentsCsv(report))
  await fs.writeFile(`${stem}-askers.csv`, renderAskersCsv(report))
  await fs.writeFile(`${stem}-hours.csv`, renderHoursCsv(report))
  if (args.json) await fs.writeFile(`${stem}.json`, JSON.stringify(report, null, 2))
  console.log(
    `\nWrote ${stem}.md, ${stem}-segments.csv, ${stem}-askers.csv, ${stem}-hours.csv${args.json ? `, ${stem}.json` : ''}`
  )

  await logAuditEvent({
    action: AUDIT_ACTIONS.PITCH_REPORT_COMPLETE,
    operation: 'export',
    stationId: station.id,
    resourceType: 'report',
    metadata: {
      window: { start, end },
      showFilter: args.show,
      airings: t.episodes,
      airingsWithTranscript: t.episodesWithTranscript,
      segments: t.segmentCount,
      pitchSeconds: Math.round(t.pitchMs / 1000),
      airtimeSeconds: Math.round(t.airtimeMs / 1000),
    },
  })
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
