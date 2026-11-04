// Shared, pure formatting + link helpers for the browse/search views (Broadcast
// Day, Search, Show report, People). One place for "how does an air time read",
// "how does a seek offset read" and "what URL opens an episode at a moment", so
// the four views can't drift. No React, no DB — unit-tested in
// broadcast-format.test.ts.

import { episodeHref, withFrom } from './nav'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string | null | undefined): s is string {
  if (!s) return false
  const m = s.match(DATE_RE)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

/** Add `days` to a YYYY-MM-DD date (calendar arithmetic, no timezone). */
export function shiftDate(date: string, days: number): string {
  const m = date.match(DATE_RE)
  if (!m) return date
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days))
  return d.toISOString().slice(0, 10)
}

/** Today's date in the station's timezone (episode air_date is station-local). */
export function stationToday(timeZone = 'America/Los_Angeles', now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** "2026-10-09" → "Fri, Oct 9, 2026" (or without the weekday). */
export function formatAirDate(date: string | null | undefined, opts: { weekday?: boolean; year?: boolean } = {}): string {
  if (!date) return '—'
  const m = date.match(DATE_RE)
  if (!m) return date
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  const core = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  const withYear = opts.year === false ? core : `${core}, ${d.getUTCFullYear()}`
  return opts.weekday === false ? withYear : `${WEEKDAYS[d.getUTCDay()]}, ${withYear}`
}

/** Postgres `time` ("07:00:00" / "21:30") → "7:00 AM" / "9:30 PM". */
export function formatAirTime(time: string | null | undefined): string {
  if (!time) return '—'
  const m = time.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return time
  const h = +m[1]
  const suffix = h >= 12 && h < 24 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m[2]} ${suffix}`
}

/** "07:00:00" → minutes after midnight (null when unparseable). */
export function timeToMinutes(time: string | null | undefined): number | null {
  if (!time) return null
  const m = time.match(/^(\d{1,2}):(\d{2})/)
  return m ? +m[1] * 60 + +m[2] : null
}

/** A playback offset in ms → "4:05" or "1:02:03". */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Duration in seconds → "1h", "58m", "1h 30m". */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const mins = Math.round(seconds / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/** Wall-clock time of a moment inside an airing: air_start + offset → "9:14 AM". */
export function formatMomentClock(airStart: string | null | undefined, offsetMs: number): string | null {
  const start = timeToMinutes(airStart)
  if (start == null) return null
  const mins = (start + Math.floor(offsetMs / 60000)) % (24 * 60)
  return formatAirTime(`${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`)
}

/** Episode detail URL, optionally opened at a moment (the detail page's
 *  `?seek=<seconds>` starts the audio + scrolls the transcript there) and
 *  remembering where the user came from for the back link. */
export function episodeMomentHref(id: number | string, offsetMs?: number | null, from?: string | null): string {
  if (offsetMs == null || !Number.isFinite(offsetMs)) return episodeHref(id, from)
  return withFrom(`/dashboard/episodes/${id}?seek=${(Math.max(0, offsetMs) / 1000).toFixed(1)}`, from)
}

/** Broadcast Day URL for a date (and optionally an hour to scroll to). */
export function broadcastDayHref(date: string, hour?: number | null): string {
  return hour == null ? `/dashboard/day?date=${date}` : `/dashboard/day?date=${date}&at=${String(hour).padStart(2, '0')}:00`
}

/** People page URL for one person. */
export function personHref(name: string): string {
  return `/dashboard/people?name=${encodeURIComponent(name)}`
}

/** Show report URL for a show over a period. */
export function showReportHref(showKey: string, from?: string | null, to?: string | null): string {
  const p = new URLSearchParams({ show: showKey })
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  return `/dashboard/show-report?${p}`
}

/** First/last day of the month containing `date` (YYYY-MM-DD). */
export function monthRange(date: string): { from: string; to: string } {
  const m = date.match(DATE_RE)
  if (!m) return { from: date, to: date }
  const first = `${m[1]}-${m[2]}-01`
  const last = new Date(Date.UTC(+m[1], +m[2], 0)).toISOString().slice(0, 10)
  return { from: first, to: last }
}
