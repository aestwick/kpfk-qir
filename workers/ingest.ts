import { Job } from 'bullmq'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../lib/supabase'
import { getExcludedCategories, getExcludedShowKeys, isPipelinePaused } from '../lib/settings'
import { parseMp3Url, dateFieldsFromUrl } from '../lib/parse-mp3-url'
import { rssText } from '../lib/rss'
import { listStationIds, getStation } from '../lib/stations'
import { ingestQueue } from '../lib/queue'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { fetchConfessorEpisodes, normalizeConfessorMp3Url, projectPubfile } from '../lib/confessor'
import { buildHumanFieldSources } from '../lib/field-sources'

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

/** Has this station already ingested an episode with this MP3 URL? (cross-source dedupe key) */
async function episodeExists(stationId: string, mp3Url: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from('episode_log')
    .select('id')
    .eq('station_id', stationId)
    .eq('mp3_url', mp3Url)
    .limit(1)
  return !!data?.length
}

const PACIFIC = 'America/Los_Angeles'

/** Pacific-time wall-clock for an end instant derived from start + duration. */
function computeEnd(startMs: number, durationMinutes: number | null): { endTime: string; airEnd: string } {
  if (!durationMinutes) return { endTime: '', airEnd: '' }
  const end = new Date(startMs + durationMinutes * 60 * 1000)
  const endTime = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(end)
  const airEnd = new Intl.DateTimeFormat('en-GB', {
    timeZone: PACIFIC, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(end)
  return { endTime, airEnd }
}

/**
 * Pull a show's recent episodes from the Confessor API (`?req=fil`), preserving
 * the human-entered pubfile metadata. Returns { count, ok }: ok=false signals a
 * fetch/parse failure so the caller can fall back to RSS for this show. ok=true
 * with count=0 means Confessor answered but the show has nothing new.
 */
async function processShowConfessor(
  show: { key: string; show_name: string; category: string },
  station: { id: string; confessorBase: string; archiveBase: string },
  num: number
): Promise<{ count: number; ok: boolean }> {
  let rows
  try {
    rows = await fetchConfessorEpisodes(station.confessorBase, show.key, num)
  } catch (err) {
    console.warn(`[ingest] confessor fetch failed for ${show.key}:`, err instanceof Error ? err.message : err)
    return { count: 0, ok: false }
  }

  let newCount = 0
  for (const row of rows) {
    // `fil` only returns non-expired rows, but a row past its window reports
    // mp3="expired" instead of a URL — skip those (no audio to process).
    if (!row.mp3 || row.mp3 === 'expired') continue
    const mp3Url = normalizeConfessorMp3Url(row.mp3, station.archiveBase)
    if (await episodeExists(station.id, mp3Url)) continue

    const durationMinutes = row.lsecs ? Math.round(row.lsecs / 60) : null
    // def_time is the airing's unix timestamp (seconds) — ground truth.
    const startMs = row.def_time ? row.def_time * 1000 : null
    const startStr = startMs != null ? toPacificDate(new Date(startMs).toISOString()) : null
    const end = startMs != null ? computeEnd(startMs, durationMinutes) : { endTime: '', airEnd: '' }

    const proj = projectPubfile(row.pubfile)
    // Seed the per-field provenance with the human copies. The summarizer fills
    // the AI copies later and resolves the active winner per field (human wins
    // by default; categories default to AI — see lib/field-sources.ts).
    const fieldSources = buildHumanFieldSources({
      host: proj.host,
      guest: proj.guest,
      issue_category: proj.issueCategory,
      summary: proj.humanSummary,
    })

    const { error: insertErr } = await supabaseAdmin
      .from('episode_log')
      .insert({
        station_id: station.id,
        show_key: show.key,
        show_name: show.show_name,
        // Prefer the curated show_keys category (what the RSS path snapshots and
        // what the genre filter / exclusion lists match). The Confessor row's own
        // category drifts from the archive's ("Public Affairs- National+Syndicated"
        // vs "Public Affairs - National+Syndicated"), splitting the genre filter.
        category: show.category || row.category,
        title: row.title || null,
        date: startStr?.date ?? null,
        start_time: startStr?.startTime ?? null,
        end_time: end.endTime || null,
        duration: durationMinutes,
        mp3_url: mp3Url,
        status: 'pending',
        air_date: startStr?.airDate ?? null,
        air_start: startStr?.airStart ?? null,
        air_end: end.airEnd || null,
        // Human-authored fields from the Confessor pubfile. confessor_meta keeps
        // the raw pubfile losslessly; field_sources is the human/AI toggle layer.
        ingest_source: 'confessor',
        confessor_meta: row.pubfile && row.pubfile.length ? row.pubfile : null,
        field_sources: fieldSources,
        host: proj.host,
        guest: proj.guest,
        issue_category: proj.issueCategory,
        human_summary: proj.humanSummary,
        summary: proj.humanSummary,
        headline: null,
        transcript_url: null,
        compliance_status: null,
        compliance_report: null,
        error_message: null,
        retry_count: 0,
      })

    if (insertErr) {
      if (insertErr.code === '23505') continue
      console.warn(`[ingest] confessor insert error for ${mp3Url}:`, insertErr.message)
      continue
    }
    newCount++
  }
  return { count: newCount, ok: true }
}

async function processShow(
  show: { key: string; show_name: string; category: string; feed_name?: string | null },
  station: { id: string; rssBaseUrl: string; mp3Prefix: string }
): Promise<number> {
  let newCount = 0
  // No RSS feed configured for this station — nothing to pull (used as the
  // Confessor fallback target, which may be unset).
  if (!station.rssBaseUrl) return 0
  try {
    // rss_base_url is stored as the full prefix up to '?id=' (see migration 012),
    // so the show key is simply appended.
    const rssUrl = `${station.rssBaseUrl}${show.key}`
    const response = await fetch(rssUrl, { signal: AbortSignal.timeout(30000) })

    if (!response.ok) {
      console.warn(`[ingest] RSS fetch failed for ${show.key}: ${response.status}`)
      return 0
    }

    const xml = await response.text()
    const parsed = parser.parse(xml)

    // Capture the feed's display name from the RSS channel <title>. This is the
    // auto-derived name (display-only); a manual display_name override can win
    // over it later. Best-effort: only write when it actually changed.
    const channelTitle = rssText(parsed?.rss?.channel?.title)
    if (channelTitle && channelTitle !== (show.feed_name ?? null)) {
      const { error: feedNameErr } = await supabaseAdmin
        .from('show_keys')
        .update({ feed_name: channelTitle })
        .eq('station_id', station.id)
        .eq('key', show.key)
      if (feedNameErr) {
        console.warn(`[ingest] failed to update feed_name for ${show.key}: ${feedNameErr.message}`)
      }
    }

    const items = parsed?.rss?.channel?.item

    if (!items?.length) return 0

    for (const item of items) {
      const mp3Url =
        item.enclosure?.['@_url'] || item.enclosure?.url || null

      if (!mp3Url) continue

      const title = rssText(item.title)

      const pubDate = item.pubDate || null
      const itunesDuration =
        item['itunes:duration'] || item.duration || null
      const durationMinutes = itunesDuration
        ? Math.round(Number(itunesDuration) / 60)
        : null

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

      if (insertErr) {
        if (insertErr.code === '23505') continue
        console.warn(`[ingest] insert error for ${mp3Url}:`, insertErr.message)
        continue
      }

      newCount++
    }
  } catch (err) {
    console.error(`[ingest] error processing show ${show.key}:`, err)
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

  // Source selection. Confessor is the richer source (carries human-entered
  // host/guest/issue metadata) but is configured per station; when it's the
  // primary AND has a host, we pull from it and fall back to RSS per show on
  // failure. Otherwise it's RSS-only.
  const useConfessor = station.ingest_primary === 'confessor' && !!station.confessor_base_url

  // A station needs at least one usable source. Skip visibly (not silently) for
  // stations that haven't been configured yet.
  if (!useConfessor && !station.rss_base_url) {
    console.warn(`[ingest] station ${station.slug} has no ingest source configured — skipping`)
    return { newEpisodes: 0, skipped: 'no source configured' }
  }
  // mp3_filename_prefix defaults to 'kpfk' for backward compatibility (documented).
  // rssBaseUrl may be '' when Confessor-only — processShow no-ops on an empty base.
  const stationCtx = {
    id: station.id,
    rssBaseUrl: station.rss_base_url ?? '',
    mp3Prefix: station.mp3_filename_prefix ?? 'kpfk',
  }
  const confessorCtx = {
    id: station.id,
    confessorBase: station.confessor_base_url ?? '',
    archiveBase: station.rss_base_url ?? '',
  }
  // How many recent episodes to request per show from Confessor (matches the
  // RSS feed depth roughly; archive only returns non-expired rows anyway).
  const CONFESSOR_NUM = 10
  console.log(`[ingest] starting ${useConfessor ? 'Confessor' : 'RSS'} fetch for ${station.slug}...`)

  const excludedCategories = await getExcludedCategories(stationId)
  const excludedShowKeys = await getExcludedShowKeys(stationId)
  // Exclusion is per-feed (exact show key), so a single airing can be dropped
  // without affecting sibling airings that share the same show name.
  const excludedKeySet = new Set(excludedShowKeys.map((k) => k.trim()))

  // Get this station's active shows, minus any configured category/key exclusions
  const { data: shows, error: showsErr } = await supabaseAdmin
    .from('show_keys')
    .select('*')
    .eq('station_id', stationId)
    .eq('active', true)
    .is('archived_at', null)

  if (showsErr) throw new Error(`Failed to fetch shows: ${showsErr.message}`)
  if (!shows?.length) return { newEpisodes: 0 }

  const activeShows = shows.filter(
    (s) =>
      !excludedCategories.some((exc) => s.category?.includes(exc)) &&
      !excludedKeySet.has((s.key ?? '').trim())
  )

  // Per-show ingest: Confessor first (when primary), RSS as the per-show
  // fallback so one show's Confessor outage doesn't starve the rest.
  const ingestOneShow = async (show: typeof activeShows[number]): Promise<number> => {
    if (useConfessor) {
      const res = await processShowConfessor(show, confessorCtx, CONFESSOR_NUM)
      if (res.ok) return res.count
      console.warn(`[ingest] confessor unavailable for ${show.key} — falling back to RSS`)
    }
    return processShow(show, stationCtx)
  }

  // Process shows in parallel batches of 5
  const CONCURRENCY = 5
  let totalNew = 0

  for (let i = 0; i < activeShows.length; i += CONCURRENCY) {
    const batch = activeShows.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((show) => ingestOneShow(show)))
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
      metadata: { newEpisodes: totalNew, source: useConfessor ? 'confessor' : 'rss' },
    })
  }
  return { newEpisodes: totalNew }
}
