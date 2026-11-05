// Broadcast Day: one station-local date's log in air-time order. Pure — the API
// route loads rows, this shapes them (unit-tested in broadcast-day.test.ts).
//
// Two wrinkles from the real data:
//   * A second "online" feed re-publishes some shows a minute later under its
//     own key (MP3 prefix `2kpfk_…`, e.g. informap 20:01 vs infopac 20:00).
//     Those rows are flagged `secondaryFeed` so the UI can de-emphasise them.
//   * Two feeds of the SAME logical show (show_group) starting within a few
//     minutes are one airing: the extra rows fold into `alsoAired`.

import { timeToMinutes } from './broadcast-format'
import { catalogName, type ShowCatalog } from './show-catalog'

export interface DayEpisodeRow {
  id: number
  show_key: string
  show_name: string | null
  air_date: string | null
  air_start: string | null
  air_end: string | null
  duration: number | null // minutes
  host: string | null
  guest: string | null
  headline: string | null
  title: string | null
  issue_category: string | null
  category: string | null
  status: string
  mp3_url: string | null
}

export interface DayBlock {
  episodeId: number
  showKey: string
  showName: string
  startMin: number | null
  endMin: number | null
  airStart: string | null
  airEnd: string | null
  durationMin: number | null
  host: string | null
  guest: string | null
  headline: string | null
  issueCategory: string | null
  category: string | null
  status: string
  mp3Url: string | null
  secondaryFeed: boolean
  /** Other episode ids that are the same airing on a sibling feed. */
  alsoAired: number[]
}

/** Same-show feeds starting this close together are one airing. */
const SAME_AIRING_MINUTES = 5

/** True when an MP3 is the station's secondary/online feed (`2<prefix>_…`). */
export function isSecondaryFeed(mp3Url: string | null | undefined, prefix = 'kpfk'): boolean {
  if (!mp3Url) return false
  const file = mp3Url.split('/').pop() ?? ''
  return file.toLowerCase().startsWith(`2${prefix.toLowerCase()}_`)
}

function endMinutes(row: DayEpisodeRow, start: number | null): number | null {
  if (start == null) return null
  if (row.duration && row.duration > 0) return start + row.duration
  const end = timeToMinutes(row.air_end)
  if (end == null) return null
  return end <= start ? end + 24 * 60 : end // "00:00" end wraps past midnight
}

export function buildBroadcastDay(rows: DayEpisodeRow[], catalog: ShowCatalog, mp3Prefix = 'kpfk'): DayBlock[] {
  const blocks: (DayBlock & { group: string })[] = rows.map((r) => {
    const startMin = timeToMinutes(r.air_start)
    return {
      episodeId: r.id,
      showKey: r.show_key,
      showName: catalogName(catalog, r.show_key, r.show_name),
      group: catalog.byKey.get(r.show_key)?.group ?? r.show_key,
      startMin,
      endMin: endMinutes(r, startMin),
      airStart: r.air_start,
      airEnd: r.air_end,
      durationMin: r.duration,
      host: r.host,
      guest: r.guest,
      headline: r.headline || r.title,
      issueCategory: r.issue_category,
      category: r.category ?? catalog.byKey.get(r.show_key)?.category ?? null,
      status: r.status,
      mp3Url: r.mp3_url,
      secondaryFeed: isSecondaryFeed(r.mp3_url, mp3Prefix),
      alsoAired: [],
    }
  })

  // Air order; unknown start times last; the primary feed before its online copy.
  blocks.sort(
    (a, b) =>
      (a.startMin ?? 1e9) - (b.startMin ?? 1e9) ||
      Number(a.secondaryFeed) - Number(b.secondaryFeed) ||
      a.episodeId - b.episodeId
  )

  const out: (DayBlock & { group: string })[] = []
  for (const b of blocks) {
    const twin = out.find(
      (o) =>
        o.group === b.group &&
        o.startMin != null &&
        b.startMin != null &&
        Math.abs(o.startMin - b.startMin) <= SAME_AIRING_MINUTES
    )
    if (twin) {
      twin.alsoAired.push(b.episodeId)
      continue
    }
    out.push(b)
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return out.map(({ group, ...rest }) => rest)
}

/** Index of the block on air at `minute` (or the next one to start), for
 *  scrolling the day view to "9:00". */
export function blockAt(blocks: DayBlock[], minute: number): number {
  const on = blocks.findIndex((b) => b.startMin != null && b.startMin <= minute && (b.endMin ?? b.startMin + 60) > minute && !b.secondaryFeed)
  if (on >= 0) return on
  return blocks.findIndex((b) => b.startMin != null && b.startMin >= minute)
}
