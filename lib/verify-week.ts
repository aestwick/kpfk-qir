// Broadcast-week verification: reconcile what actually aired (episode_log) against
// the expected programming schedule (the CMS sibling app's cms_schedule_slots, read
// via the shared database). Pure logic only — no I/O — so the matching rules are
// unit-testable; scripts/verify-week.ts loads the data and renders the report.
//
// The two sides never share row identity, so matching is by show identity + time
// overlap within a day:
//   - identity: the airing's show_key against the slot's accepted QIR keys
//     (cms_show_source.qir_show_key rows for the slot's show, plus the show's
//     program_slug, which mirrors the QIR key for archive-backed shows), falling
//     back to a normalized-name comparison for label-only slots that aren't
//     linked to a CMS show row.
//   - time: minutes-since-midnight intervals; a slot whose end is at/before its
//     start wraps to the next midnight (23:00 → 00:00 = 1380..1440).
// Consecutive same-show slots are merged into one block first (the CMS models a
// 6-hour overnight strip as six hourly rows), and a single long airing may cover
// several blocks (and vice versa) — coverage is computed per block from the union
// of its matched airing intervals.

export interface ScheduleSlot {
  dayOfWeek: number // 0 = Sunday .. 6 = Saturday (cms_schedule_slots convention)
  startTime: string // 'HH:MM:SS'
  endTime: string // 'HH:MM:SS'; at/before startTime = wraps to midnight
  showId: string | null // cms_shows.id, null for label-only slots
  label: string | null
  effectiveDate: string | null // YYYY-MM-DD, null = always
  expiresDate: string | null
}

export interface CmsShow {
  id: string
  title: string | null
  programSlug: string | null
}

export interface Airing {
  episodeId: number
  showKey: string
  showName: string | null
  airDate: string // YYYY-MM-DD
  airStart: string | null // 'HH:MM:SS', null = can't be placed on the grid
  airEnd: string | null
  durationMin: number | null
  status: string
  hasTranscript: boolean
}

export interface ExpectedBlock {
  date: string
  startMin: number
  endMin: number // may exceed 1440 when the block wraps past midnight
  showTitle: string
  /** QIR show_keys that satisfy this block (mapping table + program_slug). */
  acceptedKeys: string[]
  /** Normalized display name, for label-only slots with no key mapping. */
  nameKey: string | null
  /**
   * Whether QIR ingests this show at all (an ACTIVE show_keys row matches).
   * An untracked block that "missed" isn't a broadcast problem — QIR simply
   * never records that show (music/arts programs are deliberately excluded).
   * Set by enrichBlocks; expandBlocks defaults it to true.
   */
  tracked: boolean
}

/** The QIR-side show registry rows enrichBlocks needs (show_keys). */
export interface QirShowKeyInfo {
  key: string
  showGroup: string | null
  showName: string | null
  active: boolean
}

export interface MatchedAiring {
  episodeId: number
  showKey: string
  showName: string | null
  startMin: number
  endMin: number
  matchType: 'key' | 'name'
}

export type BlockVerdict = 'aired' | 'partial' | 'missing'

export interface BlockResult extends ExpectedBlock {
  verdict: BlockVerdict
  /** Fraction of the block's span covered by matched airings (0..1). */
  coverage: number
  airings: MatchedAiring[]
}

export interface UnscheduledAiring {
  airing: Airing
  startMin: number
  endMin: number
  /** Blocks of a *different* show this airing overlaps — i.e. what it displaced. */
  displaced: Array<{ showTitle: string; startMin: number; endMin: number }>
}

export interface DayReport {
  date: string
  blocks: BlockResult[]
  unscheduled: UnscheduledAiring[]
  /** Airings with no air_start — counted, since they can't be placed on the grid. */
  unplaced: Airing[]
}

/** Overlap below this many minutes doesn't count as a match (boundary slop). */
const MIN_OVERLAP_MIN = 5
/** Coverage at/above this is 'aired'; between the floor and this is 'partial'. */
const AIRED_COVERAGE = 0.9
const PARTIAL_COVERAGE_FLOOR = 0.1

/** Lowercase, unify '&'/'and', collapse everything non-alphanumeric — so
 *  "Law & Disorder" (KPFA feed) and "Law and Disorder" (label) compare equal. */
export function normalizeName(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return n || null
}

export function timeToMin(time: string): number {
  const [h, m] = time.split(':')
  return parseInt(h, 10) * 60 + parseInt(m, 10)
}

export function minToTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Weekday of a YYYY-MM-DD string, 0 = Sunday. Computed in UTC on the bare date
 *  so no host-timezone shift creeps in (air_date is already station-local). */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

function slotIdentity(slot: ScheduleSlot): string {
  if (slot.showId) return `show:${slot.showId}`
  return `label:${normalizeName(slot.label) ?? ''}`
}

function slotActiveOn(slot: ScheduleSlot, date: string): boolean {
  if (slot.effectiveDate && date < slot.effectiveDate) return false
  if (slot.expiresDate && date > slot.expiresDate) return false
  return true
}

/**
 * Expand the recurring schedule into that date's merged expected blocks.
 * `keysByShowId` maps a CMS show id to the QIR show_keys that feed it
 * (cms_show_source); the show's program_slug is added as an accepted key too.
 */
export function expandBlocks(
  slots: ScheduleSlot[],
  showsById: Map<string, CmsShow>,
  keysByShowId: Map<string, string[]>,
  date: string
): ExpectedBlock[] {
  const dow = weekdayOf(date)
  const active = slots
    .filter((s) => s.dayOfWeek === dow && slotActiveOn(s, date))
    .map((s) => {
      const startMin = timeToMin(s.startTime)
      let endMin = timeToMin(s.endTime)
      if (endMin <= startMin) endMin += 1440
      return { slot: s, startMin, endMin }
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)

  const blocks: ExpectedBlock[] = []
  const identities: string[] = [] // parallel to blocks, for the adjacency merge
  for (const { slot, startMin, endMin } of active) {
    const identity = slotIdentity(slot)
    const prev = blocks[blocks.length - 1]
    if (prev && identities[identities.length - 1] === identity && startMin <= prev.endMin) {
      prev.endMin = Math.max(prev.endMin, endMin)
      continue
    }

    const show = slot.showId ? showsById.get(slot.showId) : undefined
    const acceptedKeys = new Set<string>()
    if (slot.showId) {
      for (const k of keysByShowId.get(slot.showId) ?? []) acceptedKeys.add(k)
      if (show?.programSlug) acceptedKeys.add(show.programSlug)
    }
    blocks.push({
      date,
      startMin,
      endMin,
      showTitle: show?.title ?? slot.label ?? show?.programSlug ?? '(unknown)',
      acceptedKeys: Array.from(acceptedKeys),
      nameKey: normalizeName(show?.title ?? slot.label),
      tracked: true,
    })
    identities.push(identity)
  }
  return blocks
}

/**
 * Enrich schedule blocks with QIR's own show registry (show_keys):
 *  - expand acceptedKeys through show_group — one logical show spans multiple
 *    feeds/keys (e.g. the overnight strip logs six hourly keys, the schedule
 *    knows one show), and grouping is the explicit show_group column, never
 *    the name (CLAUDE.md convention);
 *  - mark blocks whose show QIR doesn't actively ingest as untracked, so a
 *    "missing" verdict on them reads as "not recorded" rather than "not aired".
 *
 * Name comparison is EXACT on normalized names — the same rule reconcileDay's
 * airing fallback uses, so tracked-by-name implies matchable-by-name. That
 * symmetry requires the caller to pass names with station display prefixes
 * already stripped (lib/shows.ts#resolveShowDisplayName / cleanFeedName with
 * stations.show_name_strip_prefixes) on BOTH this registry and the airings.
 */
export function enrichBlocks(blocks: ExpectedBlock[], qirShows: QirShowKeyInfo[]): ExpectedBlock[] {
  const groupOf = new Map<string, string>()
  const keysInGroup = new Map<string, string[]>()
  const activeKeys = new Set<string>()
  const activeNames = new Set<string>()
  for (const s of qirShows) {
    if (s.showGroup) {
      groupOf.set(s.key, s.showGroup)
      const list = keysInGroup.get(s.showGroup) ?? []
      list.push(s.key)
      keysInGroup.set(s.showGroup, list)
    }
    if (s.active) {
      activeKeys.add(s.key)
      const n = normalizeName(s.showName)
      if (n) activeNames.add(n)
    }
  }

  return blocks.map((block) => {
    const expanded = new Set(block.acceptedKeys)
    for (const key of block.acceptedKeys) {
      const group = groupOf.get(key)
      if (group) for (const gk of keysInGroup.get(group) ?? []) expanded.add(gk)
    }
    const acceptedKeys = Array.from(expanded)
    const tracked =
      acceptedKeys.some((k) => activeKeys.has(k)) ||
      (!!block.nameKey && activeNames.has(block.nameKey))
    return { ...block, acceptedKeys, tracked }
  })
}

/** The airing's [start, end) interval in minutes, or null without air_start.
 *  End resolves as air_end → air_start + duration → air_start + 60. */
export function airingInterval(a: Airing): { startMin: number; endMin: number } | null {
  if (!a.airStart) return null
  const startMin = timeToMin(a.airStart)
  let endMin: number | null = null
  if (a.airEnd) {
    endMin = timeToMin(a.airEnd)
    if (endMin <= startMin) endMin += 1440
  } else if (a.durationMin && a.durationMin > 0) {
    endMin = startMin + a.durationMin
  }
  if (endMin === null) endMin = startMin + 60
  return { startMin, endMin }
}

function overlapMin(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart))
}

/** Minutes of [blockStart, blockEnd) covered by the union of the intervals. */
function coveredMinutes(
  blockStart: number,
  blockEnd: number,
  intervals: Array<{ startMin: number; endMin: number }>
): number {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.startMin, blockStart), end: Math.min(i.endMin, blockEnd) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  let covered = 0
  let cursor = blockStart
  for (const { start, end } of clipped) {
    if (end <= cursor) continue
    covered += end - Math.max(start, cursor)
    cursor = Math.max(cursor, end)
  }
  return covered
}

/** Show-identity test between a block and an airing (time overlap is separate). */
function identityMatch(block: ExpectedBlock, airing: Airing): 'key' | 'name' | null {
  if (block.acceptedKeys.includes(airing.showKey)) return 'key'
  if (block.nameKey && block.nameKey === normalizeName(airing.showName)) return 'name'
  return null
}

export interface ReconcileOpts {
  /**
   * The following day's airings. A block that wraps past midnight
   * (endMin > 1440) is covered by its post-midnight portion via these — the
   * archive logs that portion under the NEXT date, so same-date airings alone
   * can never complete a wrapping block.
   */
  nextDayAirings?: Airing[]
  /**
   * The PREVIOUS day's expected blocks. An early-morning airing that belongs to
   * yesterday's wrapping block (same show, overlapping its post-midnight span)
   * is scheduled programming, not an unscheduled finding.
   */
  prevDayBlocks?: ExpectedBlock[]
}

/**
 * Reconcile one day: score every expected block against the day's airings and
 * classify airings that satisfied no block as unscheduled (noting any scheduled
 * show they displaced). An airing may legitimately match several blocks (one
 * long recording spanning consecutive slots of the same show).
 */
export function reconcileDay(
  date: string,
  blocks: ExpectedBlock[],
  airings: Airing[],
  opts: ReconcileOpts = {}
): DayReport {
  const unplaced: Airing[] = []
  const placed: Array<{ airing: Airing; startMin: number; endMin: number }> = []
  for (const airing of airings) {
    const interval = airingInterval(airing)
    if (!interval) unplaced.push(airing)
    else placed.push({ airing, ...interval })
  }
  // Next-day airings shifted onto this day's clock (+1440) so they can cover
  // the post-midnight span of a wrapping block. Only relevant past 1440, so
  // non-wrapping blocks never see them (their endMin caps at 1440).
  const placedNext: Array<{ airing: Airing; startMin: number; endMin: number }> = []
  for (const airing of opts.nextDayAirings ?? []) {
    const interval = airingInterval(airing)
    if (interval) placedNext.push({ airing, startMin: interval.startMin + 1440, endMin: interval.endMin + 1440 })
  }

  const matchedEpisodes = new Set<number>()
  const results: BlockResult[] = blocks.map((block) => {
    const matches: MatchedAiring[] = []
    const candidates = block.endMin > 1440 ? [...placed, ...placedNext] : placed
    for (const { airing, startMin, endMin } of candidates) {
      if (overlapMin(startMin, endMin, block.startMin, block.endMin) < MIN_OVERLAP_MIN) continue
      const matchType = identityMatch(block, airing)
      if (!matchType) continue
      matches.push({
        episodeId: airing.episodeId,
        showKey: airing.showKey,
        showName: airing.showName,
        startMin,
        endMin,
        matchType,
      })
      matchedEpisodes.add(airing.episodeId)
    }
    const blockLen = block.endMin - block.startMin
    const covered = coveredMinutes(block.startMin, block.endMin, matches)
    const coverage = blockLen > 0 ? covered / blockLen : 0
    const verdict: BlockVerdict =
      coverage >= AIRED_COVERAGE ? 'aired' : coverage > PARTIAL_COVERAGE_FLOOR ? 'partial' : 'missing'
    return { ...block, verdict, coverage, airings: matches }
  })

  // An unmatched airing that satisfies YESTERDAY's wrapping block (shift this
  // day's clock +1440 onto yesterday's) aired as scheduled — suppress it.
  const coveredByPrevDay = ({ airing, startMin, endMin }: { airing: Airing; startMin: number; endMin: number }) =>
    (opts.prevDayBlocks ?? []).some(
      (b) =>
        b.endMin > 1440 &&
        identityMatch(b, airing) !== null &&
        overlapMin(startMin + 1440, endMin + 1440, b.startMin, b.endMin) >= MIN_OVERLAP_MIN
    )

  const unscheduled: UnscheduledAiring[] = placed
    .filter((p) => !matchedEpisodes.has(p.airing.episodeId) && !coveredByPrevDay(p))
    .map(({ airing, startMin, endMin }) => ({
      airing,
      startMin,
      endMin,
      displaced: blocks
        .filter((b) => overlapMin(startMin, endMin, b.startMin, b.endMin) >= MIN_OVERLAP_MIN)
        .map((b) => ({ showTitle: b.showTitle, startMin: b.startMin, endMin: b.endMin })),
    }))

  return { date, blocks: results, unscheduled, unplaced }
}

/** Every date (YYYY-MM-DD) from start to end inclusive. */
export function datesInWindow(start: string, end: string): string[] {
  const out: string[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${end}T00:00:00Z`)
  while (cursor <= stop) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
