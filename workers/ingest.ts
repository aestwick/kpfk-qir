import { Job } from 'bullmq'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../lib/supabase'
import { getExcludedCategories, getExcludedShowKeys, isPipelinePaused } from '../lib/settings'
import { parseMp3Url, dateFieldsFromUrl } from '../lib/parse-mp3-url'
import { rssText } from '../lib/rss'
import { listStationIds, getStation } from '../lib/stations'
import { ingestQueue } from '../lib/queue'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  isArray: (name) => name === 'item',
})

function toPacificDate(utcDateStr: string): {
  date: string
  airDate: string
  startTime: string
  endTime: string
  airStart: string
  airEnd: string
} {
  const d = new Date(utcDateStr)
  const pacific = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d)

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
  const startTime = timeFormatter.format(d)

  const airDateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
  }).format(d) // YYYY-MM-DD

  const time24 = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d)

  return {
    date: pacific,
    airDate: airDateFmt,
    startTime,
    endTime: '', // will be calculated from duration if available
    airStart: time24,
    airEnd: '',
  }
}

// A feed episode normalized to just what the shared insert loop needs, so the
// RSS and nu_do adapters are interchangeable. parseMp3Url-based date refinement
// (archive filename ground-truth) still runs in the loop and simply no-ops when
// a URL doesn't match the station's mp3 prefix (e.g. nu_do audio URLs).
type NormalizedEpisode = {
  mp3Url: string
  title: string | null
  pubDate: string | null
  durationMinutes: number | null
}

// The outcome of one adapter fetch: the episodes plus a health signal recorded
// onto show_keys so a silently-empty/broken feed is visible, not swallowed.
type FeedResult = {
  feedName: string | null // auto-derived display name (RSS channel title); null if none
  episodes: NormalizedEpisode[]
  status: string // ok | empty | http_<code> | error
  error?: string | null
}

type ShowRow = {
  key: string
  show_name: string
  category: string
  feed_name?: string | null
  source?: string | null
}
type StationCtx = {
  id: string
  rssBaseUrl: string
  mp3Prefix: string
  nudoBaseUrl: string | null
}

// --- RSS adapter: the original ingest path, unchanged in behavior ------------
async function fetchRssEpisodes(show: ShowRow, station: StationCtx): Promise<FeedResult> {
  // rss_base_url is stored as the full prefix up to '?id=' (see migration 012),
  // so the show key is simply appended.
  const rssUrl = `${station.rssBaseUrl}${show.key}`
  const response = await fetch(rssUrl, { signal: AbortSignal.timeout(30000) })

  if (!response.ok) {
    console.warn(`[ingest] RSS fetch failed for ${show.key}: ${response.status}`)
    return { feedName: null, episodes: [], status: `http_${response.status}`, error: `RSS ${response.status}` }
  }

  const xml = await response.text()
  const parsed = parser.parse(xml)

  // The feed's display name from the RSS channel <title> (auto-derived,
  // display-only; a manual display_name override can win over it later).
  const channelTitle = rssText(parsed?.rss?.channel?.title)
  const items = parsed?.rss?.channel?.item

  const episodes: NormalizedEpisode[] = []
  for (const item of items ?? []) {
    const mp3Url = item.enclosure?.['@_url'] || item.enclosure?.url || null
    if (!mp3Url) continue
    const itunesDuration = item['itunes:duration'] || item.duration || null
    episodes.push({
      mp3Url,
      title: rssText(item.title),
      pubDate: item.pubDate || null,
      durationMinutes: itunesDuration ? Math.round(Number(itunesDuration) / 60) : null,
    })
  }

  return {
    feedName: channelTitle || null,
    episodes,
    status: episodes.length ? 'ok' : 'empty',
  }
}

// --- nu_do adapter: Confessor _nu_do_api.php — the archive source for shows not
// exposed as a getrss feed. Public API, no auth (CORS open) — see the legacy
// systems docs. `req=fil&id=<altid>&num=<n>&json=1` returns a show's recent
// archive entries, each with a direct mp3 URL, def_time (unix air timestamp,
// seconds) and lsecs (duration, seconds). station.nudoBaseUrl is the full
// _nu_do_api.php endpoint (e.g. https://confessor.kpfk.org/_nu_do_api.php);
// show.key is the altid/idkey (same slug QIR already keys shows by).
const NUDO_FETCH_NUM = 0 // 0 = all currently-available entries (archive prunes by expiry)

type NudoEntry = {
  mp3?: string
  def_time?: number | string
  lsecs?: number | string
  title?: string
  date?: string
}

// PHP json_encode can emit a bare array, a single object, or a numeric-keyed
// map depending on the result set — normalize all three to a list of entries.
function nudoEntries(raw: unknown): NudoEntry[] {
  if (Array.isArray(raw)) return raw as NudoEntry[]
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (typeof obj.mp3 === 'string') return [obj as NudoEntry] // single entry
    const vals = Object.values(obj)
    if (vals.length && vals.every((v) => v && typeof v === 'object')) return vals as NudoEntry[]
  }
  return []
}

async function fetchNudoEpisodes(show: ShowRow, station: StationCtx): Promise<FeedResult> {
  if (!station.nudoBaseUrl) {
    return { feedName: null, episodes: [], status: 'error', error: 'nu_do not configured (station.nudo_base_url is null)' }
  }
  const sep = station.nudoBaseUrl.includes('?') ? '&' : '?'
  const url = `${station.nudoBaseUrl}${sep}req=fil&id=${encodeURIComponent(show.key)}&num=${NUDO_FETCH_NUM}&json=1`
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) {
    console.warn(`[ingest] nu_do fetch failed for ${show.key}: ${response.status}`)
    return { feedName: null, episodes: [], status: `http_${response.status}`, error: `nu_do ${response.status}` }
  }

  const entries = nudoEntries(await response.json())
  let feedName: string | null = null
  const episodes: NormalizedEpisode[] = []
  for (const entry of entries) {
    const mp3Url = typeof entry.mp3 === 'string' ? entry.mp3.trim() : ''
    if (!mp3Url) continue
    if (!feedName && entry.title) feedName = String(entry.title)
    // def_time is a unix timestamp in SECONDS; pubDate just needs to be a
    // parseable date string — the archive mp3 filename (kpfk_YYMMDD_HHMMSS…)
    // refines air_date/air_start downstream as the ground-truth, same as RSS.
    const def = Number(entry.def_time)
    const pubDate =
      Number.isFinite(def) && def > 0 ? new Date(def * 1000).toISOString() : entry.date ? String(entry.date) : null
    const lsecs = Number(entry.lsecs)
    const durationMinutes = Number.isFinite(lsecs) && lsecs > 0 ? Math.round(lsecs / 60) : null
    episodes.push({ mp3Url, title: entry.title ? String(entry.title) : null, pubDate, durationMinutes })
  }

  return { feedName, episodes, status: episodes.length ? 'ok' : 'empty' }
}

async function processShow(show: ShowRow, station: StationCtx): Promise<number> {
  let newCount = 0
  let health: { status: string; itemCount: number; error: string | null } = {
    status: 'error',
    itemCount: 0,
    error: null,
  }
  try {
    const fetcher = show.source === 'nudo' ? fetchNudoEpisodes : fetchRssEpisodes
    const result = await fetcher(show, station)
    health = { status: result.status, itemCount: result.episodes.length, error: result.error ?? null }

    // Persist the auto-derived feed name (display-only). Best-effort; only write
    // when it actually changed.
    if (result.feedName && result.feedName !== (show.feed_name ?? null)) {
      const { error: feedNameErr } = await supabaseAdmin
        .from('show_keys')
        .update({ feed_name: result.feedName })
        .eq('station_id', station.id)
        .eq('key', show.key)
      if (feedNameErr) {
        console.warn(`[ingest] failed to update feed_name for ${show.key}: ${feedNameErr.message}`)
      }
    }

    for (const ep of result.episodes) {
      const mp3Url = ep.mp3Url
      const { title, pubDate, durationMinutes } = ep

      // Check for existing episode by mp3_url within this station
      const { data: existing } = await supabaseAdmin
        .from('episode_log')
        .select('id')
        .eq('station_id', station.id)
        .eq('mp3_url', mp3Url)
        .limit(1)

      if (existing?.length) continue

      // Parse date/time — prefer URL-derived date (most reliable), fall back to RSS pubDate
      let dateInfo = {
        date: null as string | null,
        airDate: null as string | null,
        startTime: null as string | null,
        endTime: null as string | null,
        airStart: null as string | null,
        airEnd: null as string | null,
      }

      const urlParsed = parseMp3Url(mp3Url, station.mp3Prefix)

      if (pubDate) {
        const p = toPacificDate(pubDate)
        dateInfo = {
          date: p.date,
          airDate: p.airDate,
          startTime: p.startTime,
          endTime: p.endTime,
          airStart: p.airStart,
          airEnd: p.airEnd,
        }

        // Calculate end time from duration
        if (durationMinutes && pubDate) {
          const endDate = new Date(new Date(pubDate).getTime() + durationMinutes * 60 * 1000)
          const endTimeFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          }).format(endDate)
          const endTime24 = new Intl.DateTimeFormat('en-GB', {
            timeZone: 'America/Los_Angeles',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).format(endDate)
          dateInfo.endTime = endTimeFmt
          dateInfo.airEnd = endTime24
        }
      }

      // Override with URL-parsed date/time (ground truth from archive filename)
      if (urlParsed) {
        const fields = dateFieldsFromUrl(urlParsed, durationMinutes)
        dateInfo.airDate = fields.air_date
        dateInfo.airStart = fields.air_start
        dateInfo.airEnd = fields.air_end
        dateInfo.date = fields.date
        dateInfo.startTime = fields.start_time
        dateInfo.endTime = fields.end_time
      }

      const { error: insertErr } = await supabaseAdmin
        .from('episode_log')
        .insert({
          station_id: station.id,
          show_key: show.key,
          show_name: show.show_name,
          category: show.category,
          title,
          date: dateInfo.date,
          start_time: dateInfo.startTime,
          end_time: dateInfo.endTime,
          duration: durationMinutes,
          mp3_url: mp3Url,
          status: 'pending',
          air_date: dateInfo.airDate,
          air_start: dateInfo.airStart,
          air_end: dateInfo.airEnd,
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

      if (insertErr) {
        if (insertErr.code === '23505') continue
        console.warn(`[ingest] insert error for ${mp3Url}:`, insertErr.message)
        continue
      }

      newCount++
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[ingest] error processing show ${show.key}:`, err)
    health = { status: 'error', itemCount: 0, error: msg }
  } finally {
    // Record ingest health so a silently-empty/broken feed surfaces in Master
    // Control instead of being swallowed. Best-effort — never fail ingest on it.
    const { error: healthErr } = await supabaseAdmin
      .from('show_keys')
      .update({
        last_ingest_at: new Date().toISOString(),
        last_ingest_status: health.status,
        last_item_count: health.itemCount,
        last_ingest_error: health.error,
      })
      .eq('station_id', station.id)
      .eq('key', show.key)
    if (healthErr) console.warn(`[ingest] health write failed for ${show.key}: ${healthErr.message}`)
  }
  return newCount
}

export async function processIngest(job: Job) {
  const stationId = job.data?.stationId as string | undefined

  // Soft pause keeps ingest running — only the GLOBAL master pause stops it. A
  // per-station-paused station still RECEIVES new episodes (they queue as pending
  // and serve as the liveness signal); the expensive stages, gated per-station
  // downstream — the ingest→transcribe kick and each processor — hold them.
  if (await isPipelinePaused()) {
    console.log('[ingest] paused (global) — skipping')
    return { newEpisodes: 0, skipped: true }
  }

  // Cron/startup tick (no stationId): fan out one ingest job per station. Paused
  // stations are NOT skipped — ingest must keep flowing during soft pause.
  if (!stationId) {
    const ids = await listStationIds()
    for (const id of ids) {
      await ingestQueue.add('ingest-station', { stationId: id })
    }
    console.log(`[ingest] dispatched ingest for ${ids.length} station(s)`)
    return { dispatched: ids.length }
  }

  const station = await getStation(stationId)
  if (!station) throw new Error(`[ingest] station ${stationId} not found`)
  // rss_base_url is required to know where to pull feeds from. Skip visibly
  // (not silently) for stations that haven't been configured yet.
  if (!station.rss_base_url) {
    console.warn(`[ingest] station ${station.slug} has no rss_base_url configured — skipping`)
    return { newEpisodes: 0, skipped: 'no rss_base_url' }
  }
  // mp3_filename_prefix defaults to 'kpfk' for backward compatibility (documented).
  const stationCtx = {
    id: station.id,
    rssBaseUrl: station.rss_base_url,
    mp3Prefix: station.mp3_filename_prefix ?? 'kpfk',
    nudoBaseUrl: station.nudo_base_url ?? null,
  }
  console.log(`[ingest] starting RSS fetch for ${station.slug}...`)

  const excludedCategories = await getExcludedCategories(stationId)
  const excludedShowKeys = await getExcludedShowKeys(stationId)
  // Exclusion is per-feed (exact show key), so a single airing can be dropped
  // without affecting sibling airings that share the same show name.
  const excludedKeySet = new Set(excludedShowKeys.map((k) => k.trim()))

  // Get this station's active shows, excluding Music/Español
  const { data: shows, error: showsErr } = await supabaseAdmin
    .from('show_keys')
    .select('*')
    .eq('station_id', stationId)
    .eq('active', true)

  if (showsErr) throw new Error(`Failed to fetch shows: ${showsErr.message}`)
  if (!shows?.length) return { newEpisodes: 0 }

  const activeShows = shows.filter((s) => {
    // An explicit per-key exclusion always wins, even over a nu_do opt-in.
    if (excludedKeySet.has((s.key ?? '').trim())) return false
    // Flagging a show source='nudo' is a deliberate "pull this one" — it bypasses
    // the blanket category exclusion (Music/Español), which only exists to keep
    // the automatic RSS bulk focused on issue-responsive programming. Without
    // this, the nu_do backup couldn't reach the music/spirituality shows it was
    // built for (their feeds are RSS-dead AND category-excluded).
    if (s.source === 'nudo') return true
    return !excludedCategories.some((exc) => s.category?.includes(exc))
  })

  // Process shows in parallel batches of 5
  const CONCURRENCY = 5
  let totalNew = 0

  for (let i = 0; i < activeShows.length; i += CONCURRENCY) {
    const batch = activeShows.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((show) => processShow(show, stationCtx)))
    for (const result of results) {
      if (result.status === 'fulfilled') totalNew += result.value
    }
  }

  console.log(`[ingest] done — ${totalNew} new episodes ingested`)
  // System audit event (only when work happened, to keep the trail readable).
  if (totalNew > 0) {
    void logAuditEvent({
      action: AUDIT_ACTIONS.INGEST_COMPLETE,
      operation: 'insert',
      stationId,
      resourceType: 'episode',
      metadata: { newEpisodes: totalNew },
    })
  }
  return { newEpisodes: totalNew }
}
