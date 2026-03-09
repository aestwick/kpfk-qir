import { Job } from 'bullmq'
import { XMLParser } from 'fast-xml-parser'
import { supabaseAdmin } from '../lib/supabase'
import { getExcludedCategories } from '../lib/settings'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  isArray: (name) => name === 'item',
})

/**
 * Parse air date and time from archive MP3 URL.
 * Format: kpfk_YYMMDD_HHMMSSshowkey.mp3
 * e.g. kpfk_260106_233000casc.mp3 → 2026-01-06, 23:30:00
 */
function parseMp3Url(mp3Url: string): {
  airDate: string
  airStart: string
  showKey: string
} | null {
  const match = mp3Url.match(/kpfk_(\d{6})_(\d{6})([a-zA-Z]+)\.mp3/)
  if (!match) return null

  const [, datePart, timePart, showKey] = match
  const yy = datePart.slice(0, 2)
  const mm = datePart.slice(2, 4)
  const dd = datePart.slice(4, 6)
  const hh = timePart.slice(0, 2)
  const mi = timePart.slice(2, 4)
  const ss = timePart.slice(4, 6)

  const year = parseInt(yy) >= 90 ? `19${yy}` : `20${yy}`

  return {
    airDate: `${year}-${mm}-${dd}`,
    airStart: `${hh}:${mi}:${ss}`,
    showKey,
  }
}

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

async function processShow(show: { key: string; show_name: string; category: string }): Promise<number> {
  let newCount = 0
  try {
    const rssUrl = `https://archive.kpfk.org/getrss.php?id=${show.key}`
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

      // Check for existing episode by mp3_url
      const { data: existing } = await supabaseAdmin
        .from('episode_log')
        .select('id')
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

      const urlParsed = parseMp3Url(mp3Url)

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
        dateInfo.airDate = urlParsed.airDate
        dateInfo.airStart = urlParsed.airStart

        // Reformat display date from URL
        const [year, month, day] = urlParsed.airDate.split('-').map(Number)
        const urlDate = new Date(year, month - 1, day)
        dateInfo.date = new Intl.DateTimeFormat('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }).format(urlDate)

        // Reformat display start time from URL
        const hh = parseInt(urlParsed.airStart.slice(0, 2))
        const mi = urlParsed.airStart.slice(3, 5)
        const ampm = hh >= 12 ? 'PM' : 'AM'
        const hh12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh
        dateInfo.startTime = `${hh12}:${mi} ${ampm}`

        // Recalculate end time from URL start + duration
        if (durationMinutes) {
          const startMinutes = parseInt(urlParsed.airStart.slice(0, 2)) * 60 + parseInt(urlParsed.airStart.slice(3, 5))
          const endMinutes = startMinutes + durationMinutes
          const endHH = Math.floor(endMinutes / 60) % 24
          const endMI = endMinutes % 60
          const endAmpm = endHH >= 12 ? 'PM' : 'AM'
          const endHH12 = endHH === 0 ? 12 : endHH > 12 ? endHH - 12 : endHH
          dateInfo.endTime = `${endHH12}:${String(endMI).padStart(2, '0')} ${endAmpm}`
          dateInfo.airEnd = `${String(endHH).padStart(2, '0')}:${String(endMI).padStart(2, '0')}:00`
        }
      }

      const { error: insertErr } = await supabaseAdmin
        .from('episode_log')
        .insert({
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
  console.log('[ingest] starting RSS fetch...')

  const excludedCategories = await getExcludedCategories()

  // Get all active shows, excluding Music/Español
  const { data: shows, error: showsErr } = await supabaseAdmin
    .from('show_keys')
    .select('*')
    .eq('active', true)

  if (showsErr) throw new Error(`Failed to fetch shows: ${showsErr.message}`)
  if (!shows?.length) return { newEpisodes: 0 }

  const activeShows = shows.filter(
    (s) => !excludedCategories.some((exc) => s.category?.includes(exc))
  )

  // Process shows in parallel batches of 5
  const CONCURRENCY = 5
  let totalNew = 0

  for (let i = 0; i < activeShows.length; i += CONCURRENCY) {
    const batch = activeShows.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map((show) => processShow(show)))
    for (const result of results) {
      if (result.status === 'fulfilled') totalNew += result.value
    }
  }

  console.log(`[ingest] done — ${totalNew} new episodes ingested`)
  return { newEpisodes: totalNew }
}
