import { Job } from 'bullmq'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../lib/supabase'
import { getExcludedCategories, getExcludedShows, isPipelinePaused } from '../lib/settings'
import { parseMp3Url, dateFieldsFromUrl } from '../lib/parse-mp3-url'
import { listStationIds, getStation } from '../lib/stations'
import { ingestQueue } from '../lib/queue'

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

async function processShow(
  show: { key: string; show_name: string; category: string },
  station: { id: string; rssBaseUrl: string; mp3Prefix: string }
): Promise<number> {
  let newCount = 0
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
    const items = parsed?.rss?.channel?.item

    if (!items?.length) return 0

    for (const item of items) {
      const mp3Url =
        item.enclosure?.['@_url'] || item.enclosure?.url || null

      if (!mp3Url) continue

      const rawTitle = item.title
      const title = typeof rawTitle === 'object' && rawTitle?.__cdata
        ? String(rawTitle.__cdata).trim()
        : rawTitle ? String(rawTitle).trim() : null

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
  if (await isPipelinePaused()) {
    console.log('[ingest] pipeline paused — skipping')
    return { newEpisodes: 0, skipped: true }
  }

  const stationId = job.data?.stationId as string | undefined

  // Cron/startup tick (no stationId): fan out one ingest job per station.
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
  }
  console.log(`[ingest] starting RSS fetch for ${station.slug}...`)

  const excludedCategories = await getExcludedCategories(stationId)
  const excludedShows = await getExcludedShows(stationId)
  // Normalize once: name exclusion is case/whitespace-insensitive.
  const excludedShowNames = new Set(excludedShows.map((n) => n.trim().toLowerCase()))

  // Get this station's active shows, excluding Music/Español
  const { data: shows, error: showsErr } = await supabaseAdmin
    .from('show_keys')
    .select('*')
    .eq('station_id', stationId)
    .eq('active', true)

  if (showsErr) throw new Error(`Failed to fetch shows: ${showsErr.message}`)
  if (!shows?.length) return { newEpisodes: 0 }

  const activeShows = shows.filter(
    (s) =>
      !excludedCategories.some((exc) => s.category?.includes(exc)) &&
      !excludedShowNames.has((s.show_name ?? '').trim().toLowerCase())
  )

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
  return { newEpisodes: totalNew }
}
