// Station-local wall-clock for an instant. Episode air_date / air_start /
// air_end (and the display date/start_time/end_time) are the station's local
// time; ingest used to hard-code America/Los_Angeles, so every non-Pacific
// station whose filename didn't parse (e.g. KPFT's `kpfthd3_…` files, Central
// time) was stored two hours early — and showed that way in the QIR and the
// "What aired" view.

export const DEFAULT_STATION_TIMEZONE = 'America/Los_Angeles'

/** A usable IANA zone for a station row's `timezone` (falls back to Pacific). */
export function stationTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_STATION_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return tz
  } catch {
    return DEFAULT_STATION_TIMEZONE
  }
}

export interface StationWallClock {
  /** "Tuesday, October 13, 2026" */
  date: string
  /** YYYY-MM-DD */
  airDate: string
  /** "9:00 PM" */
  startTime: string
  /** HH:MM:SS (24h) */
  airStart: string
}

export function stationWallClock(instant: Date | string | number, timeZone: string): StationWallClock {
  const d = new Date(instant)
  const tz = stationTimeZone(timeZone)
  return {
    date: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d),
    airDate: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d),
    startTime: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(d),
    airStart: clock24(d, tz),
  }
}

/** End time (display + 24h) for start + duration, in the station's zone. Empty when no duration. */
export function stationEndClock(
  startMs: number,
  durationMinutes: number | null | undefined,
  timeZone: string
): { endTime: string; airEnd: string } {
  if (!durationMinutes) return { endTime: '', airEnd: '' }
  const end = new Date(startMs + durationMinutes * 60 * 1000)
  const tz = stationTimeZone(timeZone)
  return {
    endTime: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(end),
    airEnd: clock24(end, tz),
  }
}

function clock24(d: Date, tz: string): string {
  // en-GB renders midnight as "24:00:00" in some ICU builds; normalise to 00.
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .format(d)
    .replace(/^24:/, '00:')
}
