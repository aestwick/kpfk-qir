// Fund-drive pitch analytics: which shows/hours carried pitches, how many, and
// how long. Pure logic only — no I/O — so the detection rules are unit-testable;
// scripts/pitch-report.ts loads the data and writes the report.
//
// The unit of measurement is a PITCH SEGMENT, not a keyword hit. A search hit
// count can't answer "how long" — forty hits in an hour could be one 22-minute
// break or four 30-second spots. Segments come from the timed cue surface
// (transcript_cues, migration 022), so duration falls out of the cue clock
// without touching audio:
//
//   score each cue against a tiered lexicon
//     → mark cues that are strong on their own, or that sit inside a dense
//       enough neighbourhood (a live break drifts off-vocabulary for a while
//       between asks, so an isolated cue's silence proves nothing)
//     → merge marked cues separated by less than gapMs into one segment
//     → drop dust (sub-minSegmentMs) unless a strong term anchors it, since a
//       produced 30-second spot is a real pitch and must survive
//
// Tiering exists because the naive lexicon is wrong in a specific, measurable
// way: on a real KPFK drive day "dollars/$" fires 324 times and most of them are
// news copy ("$1.8 billion fund", "cost billions of dollars"), and "contribute"
// catches "immigrants who have contributed to our communities". Money and
// support language are only evidence of a pitch when donation-specific language
// is nearby — hence a window needs a MEDIUM-or-better term before weak signals
// count toward the threshold at all.
//
// This is the free, deterministic layer. It finds explicit asks (phone number,
// donate URL, premiums, pledge language); it will under-report soft pitching
// that never names an ask, and it cannot tell a live break from a produced
// spot. An AI pass over the candidate regions is the intended second layer.

export type PitchTier = 'strong' | 'medium' | 'weak'

export interface PitchTerm {
  /** Short label, surfaced in the report so a number can be traced to a phrase. */
  name: string
  pattern: RegExp
  tier: PitchTier
}

export interface PitchCue {
  startMs: number
  endMs: number
  text: string
}

/** One aired episode, as the report needs it (a row of episode_log). */
export interface PitchEpisode {
  id: number
  showKey: string
  /** show_keys.show_group ?? key — a logical show spans several feed keys. */
  showGroup: string
  showName: string | null
  airDate: string // YYYY-MM-DD, station-local
  airStart: string | null // 'HH:MM:SS', null = can't be placed on a clock
  airEnd: string | null
  durationMin: number | null
}

export interface PitchSegment {
  startMs: number
  endMs: number
  durationMs: number
  /** Highest tier seen inside the segment; 'strong' = an explicit ask. */
  tier: PitchTier
  /** Distinct lexicon terms that fired, most significant first. */
  terms: string[]
  /** Short quote so a reviewer can spot-check without opening the audio. */
  excerpt: string
}

export interface EpisodePitch {
  episode: PitchEpisode
  segments: PitchSegment[]
  segmentCount: number
  pitchMs: number
  /** Logged airtime (duration, else air_end - air_start, else last cue end). */
  airtimeMs: number
  /** pitchMs / airtimeMs, 0..1; 0 when airtime is unknown. */
  pitchRatio: number
  /** False when the episode has no cues at all — absence of evidence, not zero. */
  hasTranscript: boolean
}

export interface HourBucket {
  /** Station-local hour of the broadcast day, 0..23. */
  hour: number
  pitchMs: number
  airtimeMs: number
  pitchRatio: number
  segmentCount: number
  /** Shows logged in this hour (KPFK logs overlapping feeds, so this can be >1). */
  shows: string[]
}

export interface ShowBucket {
  showGroup: string
  showName: string
  episodes: number
  episodesWithTranscript: number
  segmentCount: number
  pitchMs: number
  airtimeMs: number
  pitchRatio: number
}

export interface DayBucket {
  date: string
  episodes: number
  segmentCount: number
  pitchMs: number
  airtimeMs: number
  pitchRatio: number
}

export interface PitchReport {
  stationSlug: string
  stationName: string
  start: string
  end: string
  episodes: EpisodePitch[]
  byDay: DayBucket[]
  byHour: HourBucket[]
  byShow: ShowBucket[]
  totals: {
    episodes: number
    episodesWithTranscript: number
    episodesWithPitch: number
    segmentCount: number
    pitchMs: number
    airtimeMs: number
    pitchRatio: number
  }
}

export interface DetectOptions {
  /** Radius of the density window, in ms (default 45s each side). */
  windowMs: number
  /** Minimum window score for a non-strong cue to be marked (default 4). */
  minWindowScore: number
  /** Marked cues closer than this merge into one segment (default 45s). */
  gapMs: number
  /** Segments shorter than this are dropped unless anchored (default 20s). */
  minSegmentMs: number
  /**
   * Score that lets a sub-minSegmentMs segment survive without a strong term
   * (default 6 = three medium terms). A 15-second produced spot — "call the
   * number, press option 2, or give online" — is a real pitch; a talk show
   * reading its own call-in line once is not, and scores 2.
   */
  minShortScore: number
  lexicon: PitchTerm[]
}

const TIER_WEIGHT: Record<PitchTier, number> = { strong: 3, medium: 2, weak: 1 }
const TIER_RANK: Record<PitchTier, number> = { strong: 3, medium: 2, weak: 1 }

/**
 * Station-agnostic pitch vocabulary. Tiers, not a flat list:
 *   strong — an explicit ask; one cue is enough to mark a pitch on its own.
 *   medium — donation-specific but occasionally journalistic; corroborates.
 *   weak   — money/support language that is overwhelmingly news copy on a talk
 *            station and only counts when medium-or-better language is nearby.
 */
export const DEFAULT_PITCH_LEXICON: PitchTerm[] = [
  // --- strong: the ask itself -------------------------------------------------
  // A number spelled with the call letters is unambiguous in any context.
  { name: 'callsign-number', pattern: /\b\d{3}[\s.-]*\d{3}[\s.-]*(?:kpfk|kpfa|kpft|wpfw|wbai)\b/i, tier: 'strong' },
  { name: 'pledge', pattern: /\bpledg(?:e|es|ed|ing)\b/i, tier: 'strong' },
  // "fund drive"/"pledge drive" names the event; bare "fundraising" is ordinary
  // speech ("I had to do fundraising for it" — a real 3-second false positive
  // this demotion removes), so it corroborates rather than marks.
  { name: 'fund-drive', pattern: /\b(?:fund|pledge)[\s-]?drive\b/i, tier: 'strong' },
  { name: 'fundraising', pattern: /\bfund[\s-]?rais(?:er|ers|ing)\b/i, tier: 'medium' },
  // "donate now", "give securely online", "contribute at kpfk.org" — the ask in
  // the imperative. One optional adverb between verb and cue word.
  { name: 'donate-imperative', pattern: /\b(?:donate|give|contribute|pledge)\s+(?:\w+ly\s+)?(?:now|today|online|at|by|whatever|generously|securely)\b/i, tier: 'strong' },
  { name: 'tax-deductible', pattern: /\btax[\s-]?deductible\b/i, tier: 'strong' },
  { name: 'thank-you-gift', pattern: /\bthank[\s-]?you\s+gifts?\b/i, tier: 'strong' },
  { name: 'sustainer', pattern: /\bsustain(?:er|ers|ing)\b/i, tier: 'strong' },
  { name: 'operators', pattern: /\boperators?\s+(?:are\s+)?(?:standing\s+by|waiting)\b/i, tier: 'strong' },
  { name: 'matching-gift', pattern: /\bmatch(?:ing)?\s+(?:gift|grant|fund|challenge|donor)\w*\b/i, tier: 'strong' },
  { name: 'keep-on-air', pattern: /\bkeep\s+(?:us|this station|kpfk|kpfa|kpft|wpfw|wbai|it)\s+on\s+the\s+air\b/i, tier: 'strong' },
  // Spanish/Portuguese asks — KPFK pitches in-language on its Spanish shows, and
  // the transcriber code-switches mid-break. Deliberately narrow: "llame al" is
  // an ask, "llamas"/"llamado" is wildfire and UN-resolution news copy.
  { name: 'donacion', pattern: /\bdonaci[oó]n\w*\b|\bdonativos?\b|\bdone\s+(?:ahora|hoy|ya)\b/i, tier: 'strong' },
  { name: 'llame-al', pattern: /\bll(?:ame|ama|amar|ámenos)\s+al\s+\(?\d/i, tier: 'strong' },
  { name: 'hagase-socio', pattern: /\bh[aá]ga(?:se)?\s+(?:socio|miembro|su\s+donaci[oó]n)\b/i, tier: 'strong' },
  { name: 'recaudacion', pattern: /\brecaudaci[oó]n\s+de\s+fondos\b|\bcampa[ñn]a\s+de\s+fondos\b/i, tier: 'strong' },

  // --- medium: donation-specific, corroborating --------------------------------
  { name: 'donation', pattern: /\bdonat(?:e|es|ed|ing|ion|ions|or|ors)\b/i, tier: 'medium' },
  { name: 'contribution', pattern: /\bcontribution\b/i, tier: 'medium' },
  { name: 'membership', pattern: /\bmembership\b/i, tier: 'medium' },
  { name: 'call-now', pattern: /\bcall\s+(?:us\s+)?(?:right\s+)?(?:now|today|in)\b/i, tier: 'medium' },
  // "call 818-985-5735", "call us at (818) 985-1234". MEDIUM, not strong: talk
  // shows read their own listener call-in line ("Call 202-808-9925") and that is
  // not a pitch. Pin the station's actual pledge line as an explicit ask by
  // adding it to the `pitch_terms` setting.
  { name: 'call-number', pattern: /\bcall(?:ing)?\s+(?:us\s+)?(?:right now\s+|now\s+|today\s+)?(?:at\s+|on\s+)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*(?:\d{4}|[a-z]{4})\b/i, tier: 'medium' },
  { name: 'make-the-call', pattern: /\b(?:make\s+(?:the|that|this)\s+call|run\s+to\s+the\s+phone|pick\s+up\s+the\s+phone)\b/i, tier: 'medium' },
  { name: 'credit-card', pattern: /\bcredit\s+cards?\b|\btarjeta\s+de\s+cr[eé]dito\b/i, tier: 'medium' },
  { name: 'goal', pattern: /\b(?:our|the|day'?s|hour'?s|show'?s)\s+goal\b/i, tier: 'medium' },
  { name: 'gift-level', pattern: /\bgift\s+levels?\b|\bat\s+the\s+\$?\d+\s+level\b/i, tier: 'medium' },
  // A thank-you gift by any of its names. "Gift certificate" is how the food and
  // theatre premiums are read on air.
  { name: 'gift-item', pattern: /\bgift\s+certificates?\b|\bcertificado\s+de\s+(?:regalo|presente)\b/i, tier: 'medium' },
  // Demoted from strong on real data: each of these is also ordinary speech on a
  // news/talk station — "insurance premiums", "the phone lines were down", and
  // "listener-sponsored radio" in the legal ID — so each now needs corroboration.
  { name: 'premium', pattern: /\bpremiums?\b/i, tier: 'medium' },
  { name: 'phone-lines', pattern: /\bphone\s+(?:lines?|bank)\b/i, tier: 'medium' },
  { name: 'listener-sponsored', pattern: /\blistener[\s-]?(?:sponsored|supported|funded)\b/i, tier: 'medium' },
  { name: 'help-station', pattern: /\bhelp\s+(?:kpfk|kpfa|kpft|wpfw|wbai|this station|us stay)\b/i, tier: 'medium' },

  // --- weak: only counts with medium-or-better nearby --------------------------
  { name: 'money', pattern: /\$\s?\d|\b\d+\s+d[oó]l(?:lars?|ares)\b/i, tier: 'weak' },
  { name: 'support-us', pattern: /\bsupport\s+(?:the|this|your|our|us|kpfk|kpfa|kpft|wpfw|wbai)\b/i, tier: 'weak' },
  { name: 'subscriber', pattern: /\bsubscribers?\b/i, tier: 'weak' },
  { name: 'member', pattern: /\bmembers?\b/i, tier: 'weak' },
  { name: 'generous', pattern: /\bgenerous(?:ly)?\b/i, tier: 'weak' },
]

/**
 * The station's own URL and its spoken variants ("kpfk dot org"). Derived from
 * the slug rather than configured, because every Pacifica station's donate URL
 * is its call letters — pass anything else (a campaign URL, a shortcode) via the
 * settings-driven `extra` list, which is treated as an explicit ask.
 *
 * MEDIUM, not strong: the legal ID reads "…and on the web at kpfk.org" every
 * hour of the year. On its own that is a station ID, not a pitch; inside a break
 * ("contribute online at kpfk.org") the imperative supplies the strong term.
 */
export function buildStationLexicon(slug: string, extra: string[] = []): PitchTerm[] {
  const call = slug.toLowerCase().replace(/[^a-z]/g, '')
  const terms: PitchTerm[] = []
  if (call) {
    terms.push({
      name: `${call}.org`,
      pattern: new RegExp(`\\b${call}\\s?(?:\\.|\\s+dot\\s+)\\s?org\\b`, 'i'),
      tier: 'medium',
    })
  }
  for (const raw of extra) {
    const t = raw.trim()
    if (!t) continue
    // Operator-supplied terms are matched literally (escaped), not as regexes —
    // a typo in a settings box should narrow a report, never crash the run.
    terms.push({
      name: t.toLowerCase(),
      pattern: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      tier: 'strong',
    })
  }
  return [...DEFAULT_PITCH_LEXICON, ...terms]
}

export const DEFAULT_DETECT_OPTIONS: Omit<DetectOptions, 'lexicon'> = {
  windowMs: 45_000,
  minWindowScore: 4,
  gapMs: 45_000,
  minSegmentMs: 20_000,
  minShortScore: 6,
}

interface ScoredCue extends PitchCue {
  score: number
  tier: PitchTier | null
  terms: string[]
}

/** Score one cue: sum of the weights of every distinct term that matched. */
export function scoreCue(cue: PitchCue, lexicon: PitchTerm[]): ScoredCue {
  let score = 0
  let tier: PitchTier | null = null
  const terms: string[] = []
  for (const term of lexicon) {
    if (!term.pattern.test(cue.text)) continue
    score += TIER_WEIGHT[term.tier]
    terms.push(term.name)
    if (!tier || TIER_RANK[term.tier] > TIER_RANK[tier]) tier = term.tier
  }
  return { ...cue, score, tier, terms }
}

/**
 * Detect pitch segments in one episode's cues. See the file header for the
 * shape of the algorithm; the rules that matter:
 *   - a strong cue marks itself (a produced 30s spot has exactly one)
 *   - a non-strong cue is marked only if its ±windowMs neighbourhood scores at
 *     least minWindowScore AND contains a medium-or-better term, so a news hour
 *     full of "$2 billion" and "supporters" never accumulates into a pitch
 *   - marked cues within gapMs of each other are one segment (hosts talk
 *     between asks; the break hasn't ended)
 */
export function detectSegments(
  cues: PitchCue[],
  options: Partial<DetectOptions> & { lexicon: PitchTerm[] }
): PitchSegment[] {
  const opts = { ...DEFAULT_DETECT_OPTIONS, ...options }
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  const scored = sorted.map((c) => scoreCue(c, opts.lexicon))

  const marked: ScoredCue[] = []
  let lo = 0
  let hi = 0
  let windowScore = 0
  let windowMedium = 0
  for (let i = 0; i < scored.length; i++) {
    const centre = scored[i].startMs
    // Slide the window bounds; both pointers only ever move forward.
    while (hi < scored.length && scored[hi].startMs <= centre + opts.windowMs) {
      windowScore += scored[hi].score
      if (scored[hi].tier && TIER_RANK[scored[hi].tier!] >= TIER_RANK.medium) windowMedium++
      hi++
    }
    while (lo < scored.length && scored[lo].startMs < centre - opts.windowMs) {
      windowScore -= scored[lo].score
      if (scored[lo].tier && TIER_RANK[scored[lo].tier!] >= TIER_RANK.medium) windowMedium--
      lo++
    }
    if (scored[i].score === 0) continue
    const isStrong = scored[i].tier === 'strong'
    if (isStrong || (windowScore >= opts.minWindowScore && windowMedium > 0)) marked.push(scored[i])
  }

  // Merge marked cues into segments.
  const segments: PitchSegment[] = []
  let run: ScoredCue[] = []
  const flush = () => {
    if (!run.length) return
    const startMs = run[0].startMs
    const endMs = Math.max(...run.map((c) => c.endMs))
    const tier = run.reduce<PitchTier>(
      (best, c) => (c.tier && TIER_RANK[c.tier] > TIER_RANK[best] ? c.tier : best),
      'weak'
    )
    const durationMs = endMs - startMs
    const score = run.reduce((sum, c) => sum + c.score, 0)
    // Dust filter: a lone weak/medium blip is more likely a passing mention than
    // a break. A strong term is an explicit ask, so it survives at any length;
    // so does a short but dense pile-up of medium terms (a produced spot).
    if (durationMs >= opts.minSegmentMs || tier === 'strong' || score >= opts.minShortScore) {
      const terms = Array.from(new Set(run.flatMap((c) => c.terms)))
      segments.push({
        startMs,
        endMs,
        durationMs,
        tier,
        terms,
        excerpt: run
          .map((c) => c.text)
          .join(' ')
          .slice(0, 240),
      })
    }
    run = []
  }
  for (const cue of marked) {
    if (run.length && cue.startMs - run[run.length - 1].endMs > opts.gapMs) flush()
    run.push(cue)
  }
  flush()
  return segments
}

// --- time helpers -----------------------------------------------------------

/** 'HH:MM:SS' → seconds since midnight; null when unparseable. */
export function timeToSec(time: string | null): number | null {
  if (!time) return null
  const m = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  return +m[1] * 3600 + +m[2] * 60 + (m[3] ? +m[3] : 0)
}

/** Seconds since midnight → 'HH:MM'; wraps past a day so 25:00 reads 01:00. */
export function secToClock(sec: number): string {
  const s = ((sec % 86400) + 86400) % 86400
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

/**
 * Logged airtime for an episode, in ms. duration (minutes) is the field ingest
 * fills from the audio, so it wins; air_end - air_start is the schedule's claim
 * and can disagree; the last cue is a floor when both are missing.
 */
export function episodeAirtimeMs(ep: PitchEpisode, cues: PitchCue[]): number {
  if (ep.durationMin && ep.durationMin > 0) return ep.durationMin * 60_000
  const start = timeToSec(ep.airStart)
  const end = timeToSec(ep.airEnd)
  if (start !== null && end !== null) {
    // An end at/before the start wraps past midnight (22:00 → 00:00 = 2h).
    const span = end > start ? end - start : end + 86400 - start
    if (span > 0) return span * 1000
  }
  return cues.length ? Math.max(...cues.map((c) => c.endMs)) : 0
}

// --- roll-ups ---------------------------------------------------------------

function ratio(pitchMs: number, airtimeMs: number): number {
  return airtimeMs > 0 ? pitchMs / airtimeMs : 0
}

/**
 * Analyse one episode. Cues are the episode's transcript_cues rows; an episode
 * with none is reported with hasTranscript=false rather than zero pitch, because
 * "we never listened" and "nothing was pitched" are different findings.
 */
export function analyzeEpisode(
  episode: PitchEpisode,
  cues: PitchCue[],
  options: Partial<DetectOptions> & { lexicon: PitchTerm[] }
): EpisodePitch {
  const segments = cues.length ? detectSegments(cues, options) : []
  const pitchMs = segments.reduce((sum, s) => sum + s.durationMs, 0)
  const airtimeMs = episodeAirtimeMs(episode, cues)
  return {
    episode,
    segments,
    segmentCount: segments.length,
    pitchMs,
    airtimeMs,
    pitchRatio: ratio(pitchMs, airtimeMs),
    hasTranscript: cues.length > 0,
  }
}

/**
 * Spread an episode's pitch and airtime across the clock hours it occupied.
 * A segment that straddles :00 is split at the boundary so an hour's pitch
 * minutes are the minutes actually pitched in that hour — the whole point of
 * the "which hours" question. Episodes with no air_start can't be placed and
 * are skipped here (they still count in the show and day roll-ups).
 */
export function rollupByHour(results: EpisodePitch[]): HourBucket[] {
  const buckets = new Map<number, HourBucket>()
  const bucket = (hour: number): HourBucket => {
    const h = ((hour % 24) + 24) % 24
    let b = buckets.get(h)
    if (!b) {
      b = { hour: h, pitchMs: 0, airtimeMs: 0, pitchRatio: 0, segmentCount: 0, shows: [] }
      buckets.set(h, b)
    }
    return b
  }

  for (const r of results) {
    const startSec = timeToSec(r.episode.airStart)
    if (startSec === null) continue
    const label = r.episode.showName ?? r.episode.showKey
    const startMsOfDay = startSec * 1000

    // Airtime, split at hour boundaries.
    spanByHour(startMsOfDay, startMsOfDay + r.airtimeMs, (hour, ms) => {
      const b = bucket(hour)
      b.airtimeMs += ms
      if (!b.shows.includes(label)) b.shows.push(label)
    })

    for (const seg of r.segments) {
      const segStart = startMsOfDay + seg.startMs
      // Attribute the segment's count to the hour it began in; its minutes are
      // split, so a break spanning :00 doesn't get counted twice as an event.
      bucket(Math.floor(segStart / 3_600_000)).segmentCount++
      spanByHour(segStart, startMsOfDay + seg.endMs, (hour, ms) => {
        bucket(hour).pitchMs += ms
      })
    }
  }

  const out = Array.from(buckets.values()).sort((a, b) => a.hour - b.hour)
  for (const b of out) b.pitchRatio = ratio(b.pitchMs, b.airtimeMs)
  return out
}

/** Call back with (hourOfDay, msInThatHour) for each hour a span touches. */
function spanByHour(startMs: number, endMs: number, fn: (hour: number, ms: number) => void): void {
  const HOUR = 3_600_000
  let cursor = startMs
  // Guard against a pathological span (bad duration data) walking forever.
  const limit = Math.min(endMs, startMs + 24 * HOUR)
  while (cursor < limit) {
    const hour = Math.floor(cursor / HOUR)
    const next = Math.min((hour + 1) * HOUR, limit)
    fn(hour, next - cursor)
    cursor = next
  }
}

export function rollupByShow(results: EpisodePitch[]): ShowBucket[] {
  const buckets = new Map<string, ShowBucket>()
  for (const r of results) {
    const key = r.episode.showGroup
    let b = buckets.get(key)
    if (!b) {
      b = {
        showGroup: key,
        showName: r.episode.showName ?? r.episode.showKey,
        episodes: 0,
        episodesWithTranscript: 0,
        segmentCount: 0,
        pitchMs: 0,
        airtimeMs: 0,
        pitchRatio: 0,
      }
      buckets.set(key, b)
    }
    b.episodes++
    if (r.hasTranscript) b.episodesWithTranscript++
    b.segmentCount += r.segmentCount
    b.pitchMs += r.pitchMs
    b.airtimeMs += r.airtimeMs
  }
  const out = Array.from(buckets.values())
  for (const b of out) b.pitchRatio = ratio(b.pitchMs, b.airtimeMs)
  return out.sort((a, b) => b.pitchMs - a.pitchMs)
}

export function rollupByDay(results: EpisodePitch[]): DayBucket[] {
  const buckets = new Map<string, DayBucket>()
  for (const r of results) {
    const key = r.episode.airDate
    let b = buckets.get(key)
    if (!b) {
      b = { date: key, episodes: 0, segmentCount: 0, pitchMs: 0, airtimeMs: 0, pitchRatio: 0 }
      buckets.set(key, b)
    }
    b.episodes++
    b.segmentCount += r.segmentCount
    b.pitchMs += r.pitchMs
    b.airtimeMs += r.airtimeMs
  }
  const out = Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date))
  for (const b of out) b.pitchRatio = ratio(b.pitchMs, b.airtimeMs)
  return out
}

export function buildReport(
  meta: { stationSlug: string; stationName: string; start: string; end: string },
  results: EpisodePitch[]
): PitchReport {
  const pitchMs = results.reduce((s, r) => s + r.pitchMs, 0)
  const airtimeMs = results.reduce((s, r) => s + r.airtimeMs, 0)
  return {
    ...meta,
    episodes: results,
    byDay: rollupByDay(results),
    byHour: rollupByHour(results),
    byShow: rollupByShow(results),
    totals: {
      episodes: results.length,
      episodesWithTranscript: results.filter((r) => r.hasTranscript).length,
      episodesWithPitch: results.filter((r) => r.segmentCount > 0).length,
      segmentCount: results.reduce((s, r) => s + r.segmentCount, 0),
      pitchMs,
      airtimeMs,
      pitchRatio: ratio(pitchMs, airtimeMs),
    },
  }
}

// --- rendering --------------------------------------------------------------

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

export function renderMarkdown(report: PitchReport): string {
  const t = report.totals
  const lines: string[] = []
  lines.push(`# Fund-drive pitch report — ${report.stationName}`)
  lines.push('')
  lines.push(`**Window:** ${report.start} → ${report.end}`)
  lines.push(
    `**Totals:** ${t.segmentCount} pitch segments, ${formatDuration(t.pitchMs)} of ${formatDuration(t.airtimeMs)} logged airtime (${pct(t.pitchRatio)}) across ${t.episodes} airings`
  )
  if (t.episodesWithTranscript < t.episodes) {
    lines.push('')
    lines.push(
      `> ${t.episodes - t.episodesWithTranscript} of ${t.episodes} airings have no transcript and are counted as 0 pitch — the totals above are a floor, not a measurement.`
    )
  }
  lines.push('')

  lines.push('## By show')
  lines.push('')
  lines.push('| Show | Airings | Pitches | Pitch time | Airtime | % pitch |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
  for (const s of report.byShow) {
    const airings = s.episodesWithTranscript < s.episodes ? `${s.episodes} (${s.episodesWithTranscript} w/ transcript)` : `${s.episodes}`
    lines.push(
      `| ${s.showName} | ${airings} | ${s.segmentCount} | ${formatDuration(s.pitchMs)} | ${formatDuration(s.airtimeMs)} | ${pct(s.pitchRatio)} |`
    )
  }
  lines.push('')

  lines.push('## By hour')
  lines.push('')
  lines.push('| Hour | Pitches | Pitch time | Airtime | % pitch | Shows |')
  lines.push('| --- | ---: | ---: | ---: | ---: | --- |')
  for (const h of report.byHour) {
    lines.push(
      `| ${secToClock(h.hour * 3600)} | ${h.segmentCount} | ${formatDuration(h.pitchMs)} | ${formatDuration(h.airtimeMs)} | ${pct(h.pitchRatio)} | ${h.shows.join(', ')} |`
    )
  }
  lines.push('')

  if (report.byDay.length > 1) {
    lines.push('## By day')
    lines.push('')
    lines.push('| Date | Airings | Pitches | Pitch time | Airtime | % pitch |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |')
    for (const d of report.byDay) {
      lines.push(
        `| ${d.date} | ${d.episodes} | ${d.segmentCount} | ${formatDuration(d.pitchMs)} | ${formatDuration(d.airtimeMs)} | ${pct(d.pitchRatio)} |`
      )
    }
    lines.push('')
  }

  lines.push('## Segments')
  lines.push('')
  for (const r of report.episodes) {
    if (!r.segmentCount) continue
    const startSec = timeToSec(r.episode.airStart)
    lines.push(
      `### ${r.episode.showName ?? r.episode.showKey} — ${r.episode.airDate} ${r.episode.airStart ?? '??'} (episode ${r.episode.id})`
    )
    lines.push('')
    lines.push(
      `${r.segmentCount} pitches, ${formatDuration(r.pitchMs)} of ${formatDuration(r.airtimeMs)} (${pct(r.pitchRatio)})`
    )
    lines.push('')
    lines.push('| At (show) | At (clock) | Length | Tier | Terms | Excerpt |')
    lines.push('| --- | --- | ---: | --- | --- | --- |')
    for (const s of r.segments) {
      const clock = startSec === null ? '—' : secToClock(startSec + Math.floor(s.startMs / 1000))
      lines.push(
        `| ${formatDuration(s.startMs)} | ${clock} | ${formatDuration(s.durationMs)} | ${s.tier} | ${s.terms.slice(0, 4).join(', ')} | ${s.excerpt.replace(/\|/g, '\\|').slice(0, 160)} |`
      )
    }
    lines.push('')
  }

  return lines.join('\n')
}

/** One row per segment — the shape development actually wants in a spreadsheet. */
export function renderSegmentsCsv(report: PitchReport): string {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [
    [
      'air_date',
      'clock_time',
      'hour',
      'show_key',
      'show_group',
      'show_name',
      'episode_id',
      'segment_start_s',
      'segment_seconds',
      'tier',
      'terms',
      'excerpt',
    ].join(','),
  ]
  for (const r of report.episodes) {
    const startSec = timeToSec(r.episode.airStart)
    for (const s of r.segments) {
      const absSec = startSec === null ? null : startSec + Math.floor(s.startMs / 1000)
      rows.push(
        [
          r.episode.airDate,
          absSec === null ? '' : secToClock(absSec),
          absSec === null ? '' : Math.floor(((absSec % 86400) + 86400) % 86400 / 3600),
          r.episode.showKey,
          r.episode.showGroup,
          r.episode.showName ?? '',
          r.episode.id,
          Math.round(s.startMs / 1000),
          Math.round(s.durationMs / 1000),
          s.tier,
          s.terms.join(' '),
          s.excerpt,
        ]
          .map(esc)
          .join(',')
      )
    }
  }
  return rows.join('\n')
}

/** One row per aired hour — the "which hours had pitches" view. */
export function renderHoursCsv(report: PitchReport): string {
  const rows = [['hour', 'pitches', 'pitch_seconds', 'airtime_seconds', 'pct_pitch', 'shows'].join(',')]
  for (const h of report.byHour) {
    rows.push(
      [
        secToClock(h.hour * 3600),
        h.segmentCount,
        Math.round(h.pitchMs / 1000),
        Math.round(h.airtimeMs / 1000),
        (h.pitchRatio * 100).toFixed(1),
        `"${h.shows.join('; ').replace(/"/g, '""')}"`,
      ].join(',')
    )
  }
  return rows.join('\n')
}
