/**
 * One-off historical backfill: load a flat list of archive MP3 URLs as episodes for
 * a given station + quarter, then kick the transcribe → summarize chain scoped to
 * that quarter's date window. The pipeline workers are otherwise pinned to the
 * CURRENT quarter (workers/transcribe.ts + summarize.ts), so a 6-years-ago backfill
 * would sit `pending` forever without the explicit `{ window }` this script passes.
 *
 * Built for Pacifica's request to retro-generate WPFW's Q4 2020 QIR from an archive
 * backup, but it's station/quarter-agnostic — reusable for the next one.
 *
 * Two phases (run insert first, wait for the pipeline to drain, then generate):
 *
 *   # 1) Insert episodes + resolve show names + kick the windowed transcribe chain
 *   tsx scripts/backfill-quarter.ts --station wpfw --year 2020 --quarter 4 \
 *       --urls ./WPFW_Q4_2020_urls.txt
 *
 *   # 2) Once the episodes reach `summarized`, build the QIR draft for the quarter
 *   tsx scripts/backfill-quarter.ts --station wpfw --year 2020 --quarter 4 --generate
 *
 * Then review / curate / finalize the draft in the dashboard (Generate page — the
 * quarter picker now reaches back far enough to select it), or finalize via the API.
 *
 * Requirements: the same env the workers run with (SUPABASE service role, REDIS_URL,
 * and — for phase 1's pipeline to actually run — GROQ/OpenAI keys + ffmpeg on the
 * worker host). Inserts are idempotent (dedupe by mp3_url), so re-running is safe.
 */
import { supabaseAdmin } from '../lib/supabase'
import { parseMp3Url, dateFieldsFromUrl } from '../lib/parse-mp3-url'
import { getQuarterDateRange } from '../lib/qir-format'
import { parseChannelMeta } from '../lib/rss'
import { transcribeQueue, complianceQueue, generateQirQueue } from '../lib/queue'
import { jobPriority } from '../lib/tier'
import * as fs from 'fs/promises'

interface Args {
  station: string
  year: number
  quarter: number
  urls?: string
  generate: boolean
  kick: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const station = get('--station')
  const year = get('--year')
  const quarter = get('--quarter')
  if (!station || !year || !quarter) {
    throw new Error(
      'Usage: tsx scripts/backfill-quarter.ts --station <slug> --year <YYYY> --quarter <1-4> [--urls <file> | --generate]'
    )
  }
  const q = parseInt(quarter, 10)
  if (q < 1 || q > 4) throw new Error(`--quarter must be 1-4 (got ${quarter})`)
  return {
    station,
    year: parseInt(year, 10),
    quarter: q,
    urls: get('--urls'),
    generate: argv.includes('--generate'),
    kick: argv.includes('--kick'),
  }
}

/**
 * Enqueue the windowed transcribe→summarize chain for a quarter. `chain: true`
 * makes transcribe auto-advance into summarize (workers/index.ts), and `window`
 * keeps every stage scoped to the backfill quarter (and lets it run past a parked
 * station's pause). The long-lived workers on the host pick this up.
 */
async function enqueueWindowedChain(stationId: string, start: string, end: string) {
  const priority = await jobPriority(stationId)
  await transcribeQueue.add(
    'backfill-transcribe',
    { stationId, source: 'chain', chain: true, window: { start, end } },
    { priority }
  )
}

/**
 * Enqueue a windowed compliance sweep — checks every already-`summarized` episode
 * in the window (the transcribe→summarize→compliance chain only auto-advances
 * episodes that summarize after it's wired, so this catches the ones already done).
 */
async function enqueueWindowedCompliance(stationId: string, start: string, end: string) {
  const priority = await jobPriority(stationId)
  await complianceQueue.add(
    'backfill-compliance',
    { stationId, window: { start, end } },
    { priority }
  )
}

async function resolveStation(slug: string) {
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('id, slug, name, rss_base_url, mp3_filename_prefix')
    .eq('slug', slug)
    .maybeSingle()
  if (error) throw new Error(`Failed to load station "${slug}": ${error.message}`)
  if (!data) throw new Error(`No station with slug "${slug}"`)
  return data as {
    id: string
    slug: string
    name: string
    rss_base_url: string | null
    mp3_filename_prefix: string | null
  }
}

/** Resolve each show key's display name + category from its live archive feed. */
async function resolveShowMeta(
  keys: string[],
  rssBaseUrl: string | null
): Promise<Map<string, { name: string | null; category: string | null }>> {
  const out = new Map<string, { name: string | null; category: string | null }>()
  if (!rssBaseUrl) {
    console.warn('[backfill] station has no rss_base_url — show names fall back to keys')
    return out
  }
  for (const key of keys) {
    try {
      const res = await fetch(`${rssBaseUrl}${key}`, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) {
        console.warn(`[backfill] feed lookup for ${key} returned ${res.status}`)
        continue
      }
      const meta = parseChannelMeta(await res.text())
      out.set(key, { name: meta.title, category: meta.category })
    } catch (err) {
      console.warn(`[backfill] feed lookup failed for ${key}:`, err instanceof Error ? err.message : err)
    }
  }
  return out
}

async function runInsert(args: Args) {
  if (!args.urls) throw new Error('--urls <file> is required to insert episodes')
  const station = await resolveStation(args.station)
  const prefix = station.mp3_filename_prefix ?? 'kpfk'
  const { start, end, label } = getQuarterDateRange(args.year, args.quarter)
  console.log(`[backfill] ${station.name} — ${label} (window ${start} .. ${end})`)

  // Load + normalize the URL list (CRLF/whitespace from copied docs; drop blanks
  // and comment lines; dedupe).
  const raw = await fs.readFile(args.urls, 'utf8')
  const urls = Array.from(
    new Set(
      raw
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
    )
  )
  console.log(`[backfill] ${urls.length} unique URLs from ${args.urls}`)

  // Parse each URL up front so we can resolve show names per distinct key, and
  // flag anything that doesn't match the archive filename pattern or falls outside
  // the target quarter (rather than silently inserting it).
  const parsed: Array<{ url: string; showKey: string; airDate: string }> = []
  const unparsed: string[] = []
  const outOfWindow: string[] = []
  for (const url of urls) {
    const p = parseMp3Url(url, prefix)
    if (!p) {
      unparsed.push(url)
      continue
    }
    if (p.airDate < start || p.airDate > end) {
      outOfWindow.push(`${url} (${p.airDate})`)
      continue
    }
    parsed.push({ url, showKey: p.showKey, airDate: p.airDate })
  }

  const distinctKeys = Array.from(new Set(parsed.map((p) => p.showKey)))
  console.log(`[backfill] ${parsed.length} in-window episodes across ${distinctKeys.length} shows`)
  const showMeta = await resolveShowMeta(distinctKeys, station.rss_base_url)

  // Register any unknown show keys as INACTIVE show_keys (opt-out onboarding
  // convention) so the report's name resolution + the dashboard know about them.
  // Never touch existing rows (a live show could already be active).
  const { data: existingRows } = await supabaseAdmin
    .from('show_keys')
    .select('key')
    .eq('station_id', station.id)
    .in('key', distinctKeys)
  const existing = new Set((existingRows ?? []).map((r) => r.key))
  const newShowRows = distinctKeys
    .filter((k) => !existing.has(k))
    .map((k) => {
      const meta = showMeta.get(k)
      return {
        station_id: station.id,
        key: k,
        show_name: meta?.name ?? k,
        feed_name: meta?.name ?? null,
        show_group: k,
        category: meta?.category ?? null,
        active: false,
      }
    })
  if (newShowRows.length) {
    const { error } = await supabaseAdmin.from('show_keys').insert(newShowRows)
    if (error) console.warn(`[backfill] show_keys insert warning: ${error.message}`)
    else console.log(`[backfill] registered ${newShowRows.length} new (inactive) show_keys`)
  }

  // Insert episodes as `pending`. Dedupe by (station_id, mp3_url) like ingest does,
  // tolerating the unique-violation race so re-runs are idempotent.
  let inserted = 0
  let duplicate = 0
  for (const ep of parsed) {
    const meta = showMeta.get(ep.showKey)
    // Derive all the date/time fields from the filename (duration unknown here —
    // it's filled from the audio during transcription).
    const f = dateFieldsFromUrl(parseMp3Url(ep.url, prefix)!, null)

    const { data: dupe } = await supabaseAdmin
      .from('episode_log')
      .select('id')
      .eq('station_id', station.id)
      .eq('mp3_url', ep.url)
      .limit(1)
    if (dupe?.length) {
      duplicate++
      continue
    }

    const { error } = await supabaseAdmin.from('episode_log').insert({
      station_id: station.id,
      show_key: ep.showKey,
      show_name: meta?.name ?? ep.showKey,
      category: meta?.category ?? null,
      title: null,
      date: f.date,
      start_time: f.start_time,
      end_time: f.end_time,
      duration: null, // filled from the audio during transcription
      mp3_url: ep.url,
      status: 'pending',
      air_date: f.air_date,
      air_start: f.air_start,
      air_end: f.air_end,
      ingest_source: 'rss',
      headline: null,
      host: null,
      guest: null,
      summary: null,
      transcript_url: null,
      compliance_status: null,
      compliance_report: null,
      issue_category: null,
      error_message: null,
      retry_count: 0,
    })
    if (error) {
      if (error.code === '23505') {
        duplicate++
        continue
      }
      console.warn(`[backfill] insert error for ${ep.url}: ${error.message}`)
      continue
    }
    inserted++
  }

  console.log(`\n[backfill] inserted ${inserted}, skipped ${duplicate} already-present`)
  if (unparsed.length) {
    console.warn(`[backfill] ${unparsed.length} URLs did not match the "${prefix}_YYMMDD_HHMMSS<key>.mp3" pattern:`)
    unparsed.forEach((u) => console.warn(`           ${u}`))
  }
  if (outOfWindow.length) {
    console.warn(`[backfill] ${outOfWindow.length} URLs fell outside ${start}..${end} (skipped):`)
    outOfWindow.forEach((u) => console.warn(`           ${u}`))
  }

  if (inserted === 0 && !args.kick) {
    console.log('[backfill] nothing new to process — not enqueuing (pass --kick to re-enqueue anyway)')
    return
  }

  await enqueueWindowedChain(station.id, start, end)
  console.log(
    `[backfill] queued transcribe → summarize for ${start}..${end}. ` +
      `Monitor via the Episodes page (filter ${args.year} Q${args.quarter}); once they reach ` +
      `"summarized", run this script again with --generate.`
  )
}

async function runKick(args: Args) {
  const station = await resolveStation(args.station)
  const { start, end } = getQuarterDateRange(args.year, args.quarter)
  // Transcribe chain drains anything still pending (→ summarize → compliance);
  // the compliance sweep catches episodes already summarized before this ran.
  await enqueueWindowedChain(station.id, start, end)
  await enqueueWindowedCompliance(station.id, start, end)
  console.log(
    `[backfill] re-kicked transcribe → summarize → compliance for ${station.name} ${start}..${end}. ` +
      `Pending episodes drain through the chain; already-summarized ones get the compliance sweep (no insert).`
  )
}

async function runGenerate(args: Args) {
  const station = await resolveStation(args.station)
  await generateQirQueue.add('backfill-generate', {
    year: args.year,
    quarter: args.quarter,
    stationId: station.id,
  })
  console.log(
    `[backfill] queued QIR generation for ${station.name} Q${args.quarter} ${args.year}. ` +
      `Review / finalize it on the dashboard Generate page (select Q${args.quarter} ${args.year}).`
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.generate) {
    await runGenerate(args)
  } else if (args.kick && !args.urls) {
    // Re-enqueue the windowed chain for an already-inserted quarter (e.g. after
    // un-parking a station, or resuming an interrupted drain) — no insert.
    await runKick(args)
  } else {
    await runInsert(args)
  }
  // Queues hold the event loop open; exit explicitly once work is enqueued.
  process.exit(0)
}

main().catch((err) => {
  console.error('[backfill] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
