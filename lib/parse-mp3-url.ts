/**
 * Parse air date, time, and show key from archive MP3 URL.
 * Format: kpfk_YYMMDD_HHMMSSshowkey.mp3
 * e.g. kpfk_260106_233000casc.mp3 → 2026-01-06, 23:30:00, casc
 */
export function parseMp3Url(mp3Url: string): {
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

/**
 * Compute all date/time fields from a parsed MP3 URL + optional duration.
 * Returns the fields ready to be saved to episode_log.
 */
export function dateFieldsFromUrl(
  parsed: NonNullable<ReturnType<typeof parseMp3Url>>,
  durationMinutes?: number | null
): {
  air_date: string
  air_start: string
  air_end: string | null
  date: string
  start_time: string
  end_time: string | null
} {
  const [year, month, day] = parsed.airDate.split('-').map(Number)
  const urlDate = new Date(year, month - 1, day)
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(urlDate)

  const hh = parseInt(parsed.airStart.slice(0, 2))
  const mi = parsed.airStart.slice(3, 5)
  const ampm = hh >= 12 ? 'PM' : 'AM'
  const hh12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh
  const startTime = `${hh12}:${mi} ${ampm}`

  let endTime: string | null = null
  let airEnd: string | null = null

  if (durationMinutes) {
    const startMinutes = hh * 60 + parseInt(mi)
    const endMinutes = startMinutes + durationMinutes
    const endHH = Math.floor(endMinutes / 60) % 24
    const endMI = endMinutes % 60
    const endAmpm = endHH >= 12 ? 'PM' : 'AM'
    const endHH12 = endHH === 0 ? 12 : endHH > 12 ? endHH - 12 : endHH
    endTime = `${endHH12}:${String(endMI).padStart(2, '0')} ${endAmpm}`
    airEnd = `${String(endHH).padStart(2, '0')}:${String(endMI).padStart(2, '0')}:00`
  }

  return {
    air_date: parsed.airDate,
    air_start: parsed.airStart,
    air_end: airEnd,
    date,
    start_time: startTime,
    end_time: endTime,
  }
}
