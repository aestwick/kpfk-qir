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
//     → drop anything with no ask in it (the intent veto), which is what
//       separates a pitch from a station promo reading the same URL
//     → classify what survived: channels named, amounts, sustainer, premium
//
// TWO AXES, deliberately separate:
//   tier (strong/medium/weak) is CONFIDENCE — how sure we are a pitch happened.
//   AskProfile is QUALITY — what the pitch actually asked for. "Named both the
//   phone number and the website" is a property of a confirmed pitch, not
//   evidence that one occurred; conflating them would hide the most interesting
//   finding, which is the pitch that asks for money and never says how to give.
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

import { datesInWindow } from './verify-week'

export type PitchTier = 'strong' | 'medium' | 'weak'

/**
 * What a term is evidence OF — the axis that decides whether something is a
 * pitch at all, kept separate from how strong the evidence is:
 *   ask     — donation intent ("pledge", "premium", "make your donation")
 *   channel — how to give: the phone number, the web address
 * A station promo names the channel with no intent ("Join us Mondays at 5am on
 * KPFK 90.7, online at kpfk.org"), so channel evidence alone never marks a
 * pitch — see the intent veto in detectSegments.
 */
export type PitchTermKind = 'ask' | 'phone' | 'web'

export interface PitchTerm {
  /** Short label, surfaced in the report so a number can be traced to a phrase. */
  name: string
  pattern: RegExp
  tier: PitchTier
  kind: PitchTermKind
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
  /**
   * Who was on the air (episode_log.host — human-entered via Confessor where
   * available, else the AI's read). The closest thing the data has to "who
   * asked"; a diarized transcript could sharpen it to the individual voice, but
   * Groq (the default provider) doesn't label speakers.
   */
  host: string | null
  airDate: string // YYYY-MM-DD, station-local
  airStart: string | null // 'HH:MM:SS', null = can't be placed on a clock
  airEnd: string | null
  durationMin: number | null
}

/**
 * What the pitch actually asked for. This is the development question, and it
 * is a DIFFERENT axis from detection confidence: `tier` says how sure we are
 * that a pitch happened, `AskProfile` says how good the ask was.
 *
 * "Complete" means the listener was told both ways to act — the phone number
 * and the web address. A break that names neither still counts as a pitch (the
 * host asked for money) but it left the listener with nowhere to go, which is
 * exactly the kind of thing a drive debrief should surface.
 */
export interface AskProfile {
  /** Phone number read on air. */
  phone: boolean
  /** Donate URL named. */
  web: boolean
  /** both → 'complete', one → 'partial', neither → 'none'. */
  completeness: 'complete' | 'partial' | 'none'
  /** Dollar figures named, ascending, deduped ("$100", "seventy-five dollars"). */
  amounts: number[]
  /** A recurring/monthly ask (sustainer, "every month", "socio mensual"). */
  sustainer: boolean
  /** A thank-you gift was offered (premium, book, tickets, gift certificate). */
  premium: boolean
  /** A match/challenge grant was invoked. */
  matching: boolean
  /** Urgency: a deadline, a countdown, "in the next N minutes", "before the hour". */
  deadline: boolean
}

export interface PitchSegment {
  startMs: number
  endMs: number
  durationMs: number
  /** Highest tier seen inside the segment; 'strong' = an explicit ask. */
  tier: PitchTier
  /** Distinct lexicon terms that fired, most significant first. */
  terms: string[]
  /** What was asked for — see AskProfile. */
  ask: AskProfile
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
  /**
   * False when the cue timeline is unusable — e.g. the whole show arrived as a
   * single caption spanning two hours (a real case in KPFK's archive). Such an
   * episode yields no segments: its transcript exists but its clock doesn't, and
   * reporting "one 2-hour pitch" would be worse than reporting nothing.
   */
  timedCues: boolean
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
  /** Dates in the window on which SOMETHING was logged in this hour. */
  daysWithAiring: number
  /** Dates on which nothing was logged — hours we did not scan, not silent hours. */
  daysUnlogged: number
}

/**
 * What the report could and could not see. Every hour of every day in the window
 * is a slot; a slot with no logged airing was never scanned, and saying "0% pitch"
 * for it would be a lie of omission. QIR only ingests shows whose show_keys row is
 * ACTIVE, so an inactive show (KPFK's fund-drive specials, for one) leaves an
 * hour-shaped hole that this section makes visible.
 */
export interface Coverage {
  daysInWindow: number
  hourSlots: number
  hourSlotsLogged: number
  ratio: number
  /** Every unscanned slot, so a gap can be chased to a specific hour. */
  gaps: { date: string; hour: number }[]
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

/**
 * One asker's drive scorecard: a show (optionally split by who hosted it) with
 * the quality of its asks, not just the quantity. This is the view that answers
 * "who asked for dollar amounts, who asked for sustainers, and how long were
 * their pitches" in one row.
 */
export interface AskerBucket {
  showGroup: string
  showName: string
  host: string | null
  airings: number
  segmentCount: number
  pitchMs: number
  airtimeMs: number
  pitchRatio: number
  /** Mean pitch length — a 6-minute break and six 1-minute breaks read differently. */
  meanSegmentMs: number
  longestSegmentMs: number
  /** Asks that named both phone and web / exactly one / neither. */
  complete: number
  partial: number
  noChannel: number
  withAmount: number
  sustainerAsks: number
  premiumAsks: number
  matchingAsks: number
  deadlineAsks: number
  /** Every dollar figure named, ascending. */
  amounts: number[]
  /** The figure named most often — the level this asker actually drives to. */
  modalAmount: number | null
  maxAmount: number | null
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
  byAsker: AskerBucket[]
  coverage: Coverage
  totals: {
    episodes: number
    episodesWithTranscript: number
    /** Transcript present but its cue clock is unusable — measured as nothing. */
    episodesUntimed: number
    episodesWithPitch: number
    segmentCount: number
    pitchMs: number
    airtimeMs: number
    pitchRatio: number
    /** Ask quality across the whole window. */
    complete: number
    partial: number
    noChannel: number
    withAmount: number
    sustainerAsks: number
    premiumAsks: number
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

// --- ask classification -----------------------------------------------------

const SUSTAINER_RE =
  /\bsustain(?:er|ers|ing)\b|\b(?:every|each|per|a)\s+month\b|\bmonthly\s+(?:gift|donation|pledge|contribution|supporter)\b|\bmensual\w*\b/i
const PREMIUM_RE =
  /\bpremiums?\b|\bthank[\s-]?you\s+gifts?\b|\bgift\s+certificates?\b|\b(?:the|this|that)\s+(?:book|dvd|cd|tickets?|t-?shirt|tote|mug)\b|\bcertificado\s+de\s+(?:regalo|presente)\b/i
const MATCHING_RE =
  /\bmatch(?:ing)?\s+(?:gift|grant|fund|challenge|donor)\w*\b|\bmatched\s+dollar\s+for\s+dollar\b|\bchallenge\s+(?:grant|gift|pledge)\b|\$\s?[\d,]+\s+challenge\b|\bif\s+(?:we|you)\s+can\s+match\b/i
const DEADLINE_RE =
  /\bin\s+the\s+next\s+(?:\w+|\d+)\s+minutes?\b|\bbefore\s+(?:the\s+)?(?:hour|end\s+of\s+(?:the\s+)?(?:hour|show|day))\b|\blast\s+(?:chance|call)\b|\bonly\s+\d+\s+minutes?\s+(?:left|remaining)\b|\bfinal\s+(?:stretch|hour|minutes)\b|\bright\s+now\s+only\b/i

// Spoken amounts Whisper writes as words rather than digits. Small on purpose:
// these are the pledge levels a drive actually uses, not a general parser.
// Each is anchored with (?:^|[^\w-]) so "seventy-five dollars" reads as 75 and
// not also as 5 — the tail of a compound is not its own pledge level.
const A = '(?:^|[^\\w-])'
const SPELLED_AMOUNTS: [RegExp, number][] = [
  [new RegExp(`${A}five\\s+dollars?\\b`, 'i'), 5],
  [new RegExp(`${A}ten\\s+dollars?\\b`, 'i'), 10],
  [new RegExp(`${A}twenty[\\s-]?five\\s+dollars?\\b`, 'i'), 25],
  [new RegExp(`${A}twenty\\s+dollars?\\b`, 'i'), 20],
  [new RegExp(`${A}thirty[\\s-]?five\\s+dollars?\\b`, 'i'), 35],
  [new RegExp(`${A}fifty\\s+dollars?\\b`, 'i'), 50],
  [new RegExp(`${A}seventy[\\s-]?five\\s+dollars?\\b`, 'i'), 75],
  [new RegExp(`${A}(?:one|a)\\s+hundred\\s+dollars?\\b`, 'i'), 100],
  [new RegExp(`${A}two\\s+hundred\\s+dollars?\\b`, 'i'), 200],
  [new RegExp(`${A}two[\\s-]?fifty\\b`, 'i'), 250],
  [new RegExp(`${A}five\\s+hundred\\s+dollars?\\b`, 'i'), 500],
  [new RegExp(`${A}(?:one|a)\\s+thousand\\s+dollars?\\b`, 'i'), 1000],
]

// Figures that are the STATION's number, not the listener's: the drive goal,
// the shortfall, the total raised. "Our goal is to raise $200,000", "we're $700
// short of our goal for the hour" — real KPFK copy, and counting either as an
// ask would report the station asking one listener for $200,000.
const GOAL_AMOUNT_RES = [
  /\b(?:goals?|targets?)\s+(?:of|is|are|was|:)?\s*\$?\s?([\d,]+)/gi,
  // "we have a $1,000 goal for Tom Hartman" / "our goal for today's program is
  // $1,000" — the hour's target, stated either side of the word.
  /\$\s?([\d,]+)\s+(?:goal|target)\b/gi,
  // …but only when the figure is linked to the goal by a copula, so "short of
  // our goal — make that $100 pledge" keeps its ask.
  /\b(?:goals?|targets?)\b[^.!?$]{0,30}?\b(?:is|was|remains|of)\s+\$\s?([\d,]+)/gi,
  /\b(?:raise|raising|raised|reach|reaching|hit)\s+(?:our\s+|the\s+|a\s+)?(?:goal\s+of\s+)?\$\s?([\d,]+)/gi,
  /\$\s?([\d,]+)\s+(?:short|away|to\s+go|left\s+to\s+raise)\b/gi,
  /\b(?:so\s+far|already)\s+(?:we(?:'ve| have)\s+)?(?:raised|collected)\s+\$\s?([\d,]+)/gi,
]

/** Figures the station named about itself (goal, shortfall, total raised). */
export function extractGoalAmounts(text: string): number[] {
  const out = new Set<number>()
  for (const re of GOAL_AMOUNT_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) out.add(Number(m[1].replace(/,/g, '')))
  }
  return Array.from(out)
}

/**
 * Dollar figures asked OF THE LISTENER. Deliberately narrow: "$100", "100
 * dollars", "75 dólares", and the spelled levels above. Bare numbers are ignored
 * — a host saying "we're at 60" is a thermometer reading, not an ask. Station
 * goal/shortfall figures are subtracted (see GOAL_AMOUNT_RES), scale words drop
 * news money ("$1.8 billion"), and anything over $10,000 is treated as
 * institutional: real pledge levels top out in the low thousands (KPFK's
 * priciest premium in this window is a $2,000 "Brunch in a Broadcast").
 */
export function extractAmounts(text: string): number[] {
  const found = new Set<number>()
  const goals = new Set(extractGoalAmounts(text))
  const push = (n: number) => {
    if (Number.isFinite(n) && n > 0 && n <= 10_000 && !goals.has(n)) found.add(n)
  }
  // Plain exec loops rather than matchAll: the project's tsconfig target
  // predates iterator spreading.
  for (const re of [
    /\$\s?(\d[\d,]*(?:\.\d+)?)(\s*(?:billion|million|trillion|bn|k)\b)?/gi,
    /\b(\d[\d,]*)\s*(?:dollars?|d[oó]lares)(\s*(?:billion|million|trillion)\b)?/gi,
  ]) {
    let m: RegExpExecArray | null
    // A scale word means news money, not a pledge level: "$1.8 billion fund"
    // would otherwise read as a $1 ask.
    while ((m = re.exec(text)) !== null) if (!m[2]) push(Number(m[1].replace(/,/g, '')))
  }
  for (const [re, value] of SPELLED_AMOUNTS) if (re.test(text)) push(value)
  return Array.from(found).sort((a, b) => a - b)
}

/** Classify what a pitch asked for, from its text and the terms that fired. */
export function classifyAsk(text: string, terms: string[], lexicon: PitchTerm[]): AskProfile {
  const byName = new Map(lexicon.map((t) => [t.name, t]))
  const kinds = new Set(terms.map((n) => byName.get(n)?.kind).filter(Boolean))
  const phone = kinds.has('phone')
  const web = kinds.has('web')
  return {
    phone,
    web,
    completeness: phone && web ? 'complete' : phone || web ? 'partial' : 'none',
    amounts: extractAmounts(text),
    sustainer: SUSTAINER_RE.test(text),
    premium: PREMIUM_RE.test(text),
    matching: MATCHING_RE.test(text),
    deadline: DEADLINE_RE.test(text),
  }
}

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
  { name: 'callsign-number', pattern: /\b\d{3}[\s.-]*\d{3}[\s.-]*(?:kpfk|kpfa|kpft|wpfw|wbai)\b/i, tier: 'strong', kind: 'phone' },
  { name: 'pledge', pattern: /\bpledg(?:e|es|ed|ing)\b/i, tier: 'strong', kind: 'ask' },
  // "fund drive"/"pledge drive" names the event; bare "fundraising" is ordinary
  // speech ("I had to do fundraising for it" — a real 3-second false positive
  // this demotion removes), so it corroborates rather than marks.
  { name: 'fund-drive', pattern: /\b(?:fund|pledge)[\s-]?drive\b/i, tier: 'strong', kind: 'ask' },
  { name: 'fundraising', pattern: /\bfund[\s-]?rais(?:er|ers|ing)\b/i, tier: 'medium', kind: 'ask' },
  // "donate now", "give securely online", "contribute at kpfk.org" — the ask in
  // the imperative. One optional adverb between verb and cue word.
  { name: 'donate-imperative', pattern: /\b(?:donate|give|contribute|pledge)\s+(?:\w+ly\s+)?(?:now|today|online|at|by|whatever|generously|securely)\b/i, tier: 'strong', kind: 'ask' },
  { name: 'tax-deductible', pattern: /\btax[\s-]?deductible\b/i, tier: 'strong', kind: 'ask' },
  { name: 'thank-you-gift', pattern: /\bthank[\s-]?you\s+gifts?\b/i, tier: 'strong', kind: 'ask' },
  { name: 'sustainer', pattern: /\bsustain(?:er|ers|ing)\b/i, tier: 'strong', kind: 'ask' },
  { name: 'operators', pattern: /\boperators?\s+(?:are\s+)?(?:standing\s+by|waiting)\b/i, tier: 'strong', kind: 'ask' },
  { name: 'matching-gift', pattern: /\bmatch(?:ing)?\s+(?:gift|grant|fund|challenge|donor)\w*\b/i, tier: 'strong', kind: 'ask' },
  { name: 'keep-on-air', pattern: /\bkeep\s+(?:us|this station|kpfk|kpfa|kpft|wpfw|wbai|it)\s+on\s+the\s+air\b/i, tier: 'strong', kind: 'ask' },
  // Spanish/Portuguese asks — KPFK pitches in-language on its Spanish shows, and
  // the transcriber code-switches mid-break. Deliberately narrow: "llame al" is
  // an ask, "llamas"/"llamado" is wildfire and UN-resolution news copy.
  { name: 'donacion', pattern: /\bdonaci[oó]n\w*\b|\bdonativos?\b|\bdone\s+(?:ahora|hoy|ya)\b/i, tier: 'strong', kind: 'ask' },
  { name: 'llame-al', pattern: /\bll(?:ame|ama|amar|ámenos)\s+al\s+\(?\d/i, tier: 'strong', kind: 'phone' },
  { name: 'hagase-socio', pattern: /\bh[aá]ga(?:se)?\s+(?:socio|miembro|su\s+donaci[oó]n)\b/i, tier: 'strong', kind: 'ask' },
  { name: 'recaudacion', pattern: /\brecaudaci[oó]n\s+de\s+fondos\b|\bcampa[ñn]a\s+de\s+fondos\b/i, tier: 'strong', kind: 'ask' },

  // --- medium: donation-specific, corroborating --------------------------------
  { name: 'donation', pattern: /\bdonat(?:e|es|ed|ing|ion|ions|or|ors)\b/i, tier: 'medium', kind: 'ask' },
  { name: 'contribution', pattern: /\bcontribution\b/i, tier: 'medium', kind: 'ask' },
  { name: 'membership', pattern: /\bmembership\b/i, tier: 'medium', kind: 'ask' },
  { name: 'call-now', pattern: /\bcall\s+(?:us\s+)?(?:right\s+)?(?:now|today|in)\b/i, tier: 'medium', kind: 'phone' },
  // "call 818-985-5735", "call us at (818) 985-1234". MEDIUM, not strong: talk
  // shows read their own listener call-in line ("Call 202-808-9925") and that is
  // not a pitch. Pin the station's actual pledge line as an explicit ask by
  // adding it to the `pitch_terms` setting.
  { name: 'call-number', pattern: /\bcall(?:ing)?\s+(?:us\s+)?(?:right now\s+|now\s+|today\s+)?(?:at\s+|on\s+)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*(?:\d{4}|[a-z]{4})\b/i, tier: 'medium', kind: 'phone' },
  { name: 'make-the-call', pattern: /\b(?:make\s+(?:the|that|this)\s+call|run\s+to\s+the\s+phone|pick\s+up\s+the\s+phone)\b/i, tier: 'medium', kind: 'phone' },
  { name: 'credit-card', pattern: /\bcredit\s+cards?\b|\btarjeta\s+de\s+cr[eé]dito\b/i, tier: 'medium', kind: 'ask' },
  { name: 'goal', pattern: /\b(?:our|the|day'?s|hour'?s|show'?s)\s+goal\b/i, tier: 'medium', kind: 'ask' },
  { name: 'gift-level', pattern: /\bgift\s+levels?\b|\bat\s+the\s+\$?\d+\s+level\b/i, tier: 'medium', kind: 'ask' },
  // A thank-you gift by any of its names. "Gift certificate" is how the food and
  // theatre premiums are read on air.
  { name: 'gift-item', pattern: /\bgift\s+certificates?\b|\bcertificado\s+de\s+(?:regalo|presente)\b/i, tier: 'medium', kind: 'ask' },
  // Demoted from strong on real data: each of these is also ordinary speech on a
  // news/talk station — "insurance premiums", "the phone lines were down", and
  // "listener-sponsored radio" in the legal ID — so each now needs corroboration.
  { name: 'premium', pattern: /\bpremiums?\b/i, tier: 'medium', kind: 'ask' },
  { name: 'phone-lines', pattern: /\bphone\s+(?:lines?|bank)\b/i, tier: 'medium', kind: 'phone' },
  { name: 'listener-sponsored', pattern: /\blistener[\s-]?(?:sponsored|supported|funded)\b/i, tier: 'medium', kind: 'ask' },
  { name: 'help-station', pattern: /\bhelp\s+(?:kpfk|kpfa|kpft|wpfw|wbai|this station|us stay)\b/i, tier: 'medium', kind: 'ask' },

  // --- weak: only counts with medium-or-better nearby --------------------------
  { name: 'money', pattern: /\$\s?\d|\b\d+\s+d[oó]l(?:lars?|ares)\b/i, tier: 'weak', kind: 'ask' },
  { name: 'support-us', pattern: /\bsupport\s+(?:the|this|your|our|us|kpfk|kpfa|kpft|wpfw|wbai)\b/i, tier: 'weak', kind: 'ask' },
  { name: 'subscriber', pattern: /\bsubscribers?\b/i, tier: 'weak', kind: 'ask' },
  { name: 'member', pattern: /\bmembers?\b/i, tier: 'weak', kind: 'ask' },
  { name: 'generous', pattern: /\bgenerous(?:ly)?\b/i, tier: 'weak', kind: 'ask' },
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
      kind: 'web',
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
      // An operator adds a term because it IS the ask (the pledge line, a
      // campaign name), so it satisfies the intent veto on its own.
      kind: 'ask',
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
    const terms = Array.from(new Set(run.flatMap((c) => c.terms)))

    // Intent veto: a pitch has to ASK for something. A station promo names the
    // channel with no ask attached ("Join us Mondays at 5 a.m. on KPFK 90.7,
    // online at kpfk.org") and so does the hourly legal ID, so channel evidence
    // alone — however loud — is never a pitch. Weak money/support language
    // doesn't carry intent either; it only ever corroborates.
    const byName = new Map(opts.lexicon.map((t) => [t.name, t]))
    const hasIntent = terms.some((n) => {
      const term = byName.get(n)
      return term?.kind === 'ask' && term.tier !== 'weak'
    })

    // Dust filter: a lone weak/medium blip is more likely a passing mention than
    // a break. A strong term is an explicit ask, so it survives at any length;
    // so does a short but dense pile-up of medium terms (a produced spot).
    const longEnough = durationMs >= opts.minSegmentMs || tier === 'strong' || score >= opts.minShortScore
    if (hasIntent && longEnough) {
      // Read the WHOLE span, not just the cues that scored: the amount, the
      // premium and the deadline are usually said in the sentences between the
      // asks ("...matched dollar for dollar in the next ten minutes"), which
      // carry no lexicon term of their own. Detection uses marked cues;
      // classification and the excerpt use everything inside the segment.
      const text = scored
        .filter((c) => c.startMs >= startMs && c.startMs <= endMs)
        .map((c) => c.text)
        .join(' ')
      segments.push({
        startMs,
        endMs,
        durationMs,
        tier,
        terms,
        ask: classifyAsk(text, terms, opts.lexicon),
        excerpt: text.slice(0, 240),
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
  const airtimeMs = episodeAirtimeMs(episode, cues)
  const timedCues = hasUsableTimeline(cues, airtimeMs)
  const segments = cues.length && timedCues ? detectSegments(cues, options) : []
  const pitchMs = segments.reduce((sum, s) => sum + s.durationMs, 0)
  return {
    episode,
    segments,
    segmentCount: segments.length,
    pitchMs,
    airtimeMs,
    pitchRatio: ratio(pitchMs, airtimeMs),
    hasTranscript: cues.length > 0,
    timedCues,
  }
}

/**
 * Is this cue timeline precise enough to measure durations from? A caption cue
 * is seconds long; one that swallows half the show means the transcript arrived
 * without real timings, and every duration derived from it would be fiction.
 */
export function hasUsableTimeline(cues: PitchCue[], airtimeMs: number): boolean {
  if (!cues.length) return false
  const longest = Math.max(...cues.map((c) => c.endMs - c.startMs))
  if (longest > MAX_PLAUSIBLE_CUE_MS) return false
  return airtimeMs <= 0 || longest <= airtimeMs / 2
}

/** No real caption runs longer than this; beyond it the timings are artifacts. */
export const MAX_PLAUSIBLE_CUE_MS = 120_000

/**
 * Spread an episode's pitch and airtime across the clock hours it occupied.
 * A segment that straddles :00 is split at the boundary so an hour's pitch
 * minutes are the minutes actually pitched in that hour — the whole point of
 * the "which hours" question. Episodes with no air_start can't be placed and
 * are skipped here (they still count in the show and day roll-ups).
 */
export function rollupByHour(results: EpisodePitch[], dates: string[] = []): HourBucket[] {
  // Every hour exists in the output whether or not anything aired in it: an hour
  // missing from the table reads as "nothing was pitched", when the truth may be
  // "nothing was recorded". See Coverage.
  const buckets = new Map<number, HourBucket>()
  const loggedSlots = new Set<string>()
  const bucket = (hour: number): HourBucket => {
    const h = ((hour % 24) + 24) % 24
    let b = buckets.get(h)
    if (!b) {
      b = {
        hour: h,
        pitchMs: 0,
        airtimeMs: 0,
        pitchRatio: 0,
        segmentCount: 0,
        shows: [],
        daysWithAiring: 0,
        daysUnlogged: 0,
      }
      buckets.set(h, b)
    }
    return b
  }
  for (let h = 0; h < 24; h++) bucket(h)

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
      loggedSlots.add(`${r.episode.airDate} ${((hour % 24) + 24) % 24}`)
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
  for (const b of out) {
    b.pitchRatio = ratio(b.pitchMs, b.airtimeMs)
    b.daysWithAiring = dates.filter((d) => loggedSlots.has(`${d} ${b.hour}`)).length
    b.daysUnlogged = dates.length - b.daysWithAiring
  }
  return out
}

/** Which (date, hour) slots in the window had no logged airing at all. */
export function computeCoverage(results: EpisodePitch[], dates: string[]): Coverage {
  const logged = new Set<string>()
  for (const r of results) {
    const startSec = timeToSec(r.episode.airStart)
    if (startSec === null) continue
    spanByHour(startSec * 1000, startSec * 1000 + r.airtimeMs, (hour) => {
      logged.add(`${r.episode.airDate} ${((hour % 24) + 24) % 24}`)
    })
  }
  const gaps: { date: string; hour: number }[] = []
  for (const date of dates) {
    for (let hour = 0; hour < 24; hour++) {
      if (!logged.has(`${date} ${hour}`)) gaps.push({ date, hour })
    }
  }
  const hourSlots = dates.length * 24
  return {
    daysInWindow: dates.length,
    hourSlots,
    hourSlotsLogged: hourSlots - gaps.length,
    ratio: hourSlots > 0 ? (hourSlots - gaps.length) / hourSlots : 0,
    gaps,
  }
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

/**
 * The level an asker actually drives to, from [amount, timesNamed] pairs: the
 * most-repeated figure (ties to the larger), or the median when nothing repeats.
 * A plain "most frequent" would report the single largest figure any time every
 * amount was said once — which made a show that mentioned $1,000 in passing look
 * like a $1,000 show.
 */
export function usualAmount(counts: [number, number][]): number | null {
  if (!counts.length) return null
  const repeated = counts.filter(([, n]) => n > 1)
  if (repeated.length) {
    return repeated.sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
  }
  const sorted = counts.map(([a]) => a).sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

/**
 * Per-asker scorecard. Keyed by show group + host, so a show that changed hands
 * mid-drive (or a guest pitcher) doesn't have its numbers averaged away — pass
 * splitByHost=false to collapse back to one row per show.
 */
export function rollupByAsker(results: EpisodePitch[], splitByHost = true): AskerBucket[] {
  const buckets = new Map<string, AskerBucket & { _amountCounts: Map<number, number> }>()
  for (const r of results) {
    const host = splitByHost ? r.episode.host : null
    const key = `${r.episode.showGroup}::${host ?? ''}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        showGroup: r.episode.showGroup,
        showName: r.episode.showName ?? r.episode.showKey,
        host: host ?? null,
        airings: 0,
        segmentCount: 0,
        pitchMs: 0,
        airtimeMs: 0,
        pitchRatio: 0,
        meanSegmentMs: 0,
        longestSegmentMs: 0,
        complete: 0,
        partial: 0,
        noChannel: 0,
        withAmount: 0,
        sustainerAsks: 0,
        premiumAsks: 0,
        matchingAsks: 0,
        deadlineAsks: 0,
        amounts: [],
        modalAmount: null,
        maxAmount: null,
        _amountCounts: new Map(),
      }
      buckets.set(key, b)
    }
    b.airings++
    b.airtimeMs += r.airtimeMs
    b.pitchMs += r.pitchMs
    b.segmentCount += r.segmentCount
    for (const s of r.segments) {
      b.longestSegmentMs = Math.max(b.longestSegmentMs, s.durationMs)
      if (s.ask.completeness === 'complete') b.complete++
      else if (s.ask.completeness === 'partial') b.partial++
      else b.noChannel++
      if (s.ask.amounts.length) b.withAmount++
      if (s.ask.sustainer) b.sustainerAsks++
      if (s.ask.premium) b.premiumAsks++
      if (s.ask.matching) b.matchingAsks++
      if (s.ask.deadline) b.deadlineAsks++
      for (const amount of s.ask.amounts) {
        b._amountCounts.set(amount, (b._amountCounts.get(amount) ?? 0) + 1)
      }
    }
  }

  const out = Array.from(buckets.values()).map((b) => {
    const counts = Array.from(b._amountCounts.entries())
    const { _amountCounts, ...rest } = b
    return {
      ...rest,
      pitchRatio: ratio(b.pitchMs, b.airtimeMs),
      meanSegmentMs: b.segmentCount ? Math.round(b.pitchMs / b.segmentCount) : 0,
      amounts: counts.map(([a]) => a).sort((x, y) => x - y),
      modalAmount: usualAmount(counts),
      maxAmount: counts.length ? Math.max(...counts.map(([a]) => a)) : null,
    }
  })
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
  const segments = results.flatMap((r) => r.segments)
  const dates = datesInWindow(meta.start, meta.end)
  return {
    ...meta,
    episodes: results,
    byDay: rollupByDay(results),
    byHour: rollupByHour(results, dates),
    coverage: computeCoverage(results, dates),
    byShow: rollupByShow(results),
    byAsker: rollupByAsker(results),
    totals: {
      episodes: results.length,
      episodesWithTranscript: results.filter((r) => r.hasTranscript).length,
      episodesUntimed: results.filter((r) => r.hasTranscript && !r.timedCues).length,
      episodesWithPitch: results.filter((r) => r.segmentCount > 0).length,
      segmentCount: segments.length,
      pitchMs,
      airtimeMs,
      pitchRatio: ratio(pitchMs, airtimeMs),
      complete: segments.filter((s) => s.ask.completeness === 'complete').length,
      partial: segments.filter((s) => s.ask.completeness === 'partial').length,
      noChannel: segments.filter((s) => s.ask.completeness === 'none').length,
      withAmount: segments.filter((s) => s.ask.amounts.length > 0).length,
      sustainerAsks: segments.filter((s) => s.ask.sustainer).length,
      premiumAsks: segments.filter((s) => s.ask.premium).length,
    },
  }
}

// --- rendering --------------------------------------------------------------

const pct = (r: number) => `${(r * 100).toFixed(1)}%`

export function renderMarkdown(report: PitchReport): string {
  const t = report.totals
  const c = report.coverage
  const lines: string[] = []
  lines.push(`# Fund-drive pitch report — ${report.stationName}`)
  lines.push('')
  lines.push(`**Window:** ${report.start} → ${report.end}`)
  lines.push(
    `**Totals:** ${t.segmentCount} pitch segments, ${formatDuration(t.pitchMs)} of ${formatDuration(t.airtimeMs)} logged airtime (${pct(t.pitchRatio)}) across ${t.episodes} airings`
  )
  lines.push('')
  lines.push(
    `**Ask quality:** ${t.complete} named phone + web, ${t.partial} named one, ${t.noChannel} named neither · ${t.withAmount} named a dollar amount · ${t.sustainerAsks} asked for sustainers · ${t.premiumAsks} offered a premium`
  )
  if (t.episodesWithTranscript < t.episodes || t.episodesUntimed) {
    const missing = t.episodes - t.episodesWithTranscript
    const notes: string[] = []
    if (missing) notes.push(`${missing} have no transcript`)
    if (t.episodesUntimed) notes.push(`${t.episodesUntimed} have an unusable cue timeline (one caption spanning the show)`)
    lines.push('')
    lines.push(
      `> Of ${t.episodes} airings, ${notes.join(' and ')} — counted as 0 pitch. The totals above are a floor, not a measurement.`
    )
  }
  lines.push('')

  lines.push('## Who asked, and for what')
  lines.push('')
  lines.push(
    '| Show | Host | Pitches | Pitch time | Mean | Longest | Phone+web | Named $ | Amounts | Usual ask | Sustainer | Premium |'
  )
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |')
  for (const a of report.byAsker) {
    if (!a.segmentCount) continue
    const amounts = a.amounts.length
      ? a.amounts.slice(0, 8).map((n) => `$${n}`).join(' ') + (a.amounts.length > 8 ? ' …' : '')
      : '—'
    lines.push(
      `| ${a.showName} | ${a.host ?? '—'} | ${a.segmentCount} | ${formatDuration(a.pitchMs)} | ${formatDuration(a.meanSegmentMs)} | ${formatDuration(a.longestSegmentMs)} | ${a.complete}/${a.segmentCount} | ${a.withAmount} | ${amounts} | ${a.modalAmount ? `$${a.modalAmount}` : '—'} | ${a.sustainerAsks} | ${a.premiumAsks} |`
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
  lines.push('Every hour of the broadcast day, whether or not anything was logged in it.')
  lines.push('')
  lines.push('| Hour | Pitches | Pitch time | Airtime | % pitch | Days unlogged | Shows |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const h of report.byHour) {
    const unlogged = h.daysUnlogged ? `${h.daysUnlogged} of ${c.daysInWindow}` : '—'
    const shows = h.shows.length ? h.shows.join(', ') : '_no airing logged_'
    lines.push(
      `| ${secToClock(h.hour * 3600)} | ${h.segmentCount} | ${formatDuration(h.pitchMs)} | ${formatDuration(h.airtimeMs)} | ${h.airtimeMs ? pct(h.pitchRatio) : '—'} | ${unlogged} | ${shows} |`
    )
  }
  lines.push('')

  lines.push('## Coverage')
  lines.push('')
  lines.push(
    `${c.hourSlotsLogged} of ${c.hourSlots} hour-slots in the window had a logged airing (${pct(c.ratio)}). An unlogged hour was never scanned — it is not an hour without pitching.`
  )
  lines.push('')
  if (c.gaps.length) {
    lines.push('| Date | Unscanned hours |')
    lines.push('| --- | --- |')
    const byDate = new Map<string, number[]>()
    for (const g of c.gaps) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g.hour])
    for (const [date, hrs] of Array.from(byDate.entries())) {
      lines.push(`| ${date} | ${hrs.map((h) => secToClock(h * 3600)).join(', ')} |`)
    }
    lines.push('')
  }

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
    lines.push('| At (show) | At (clock) | Length | Ask | Amounts | Flags | Excerpt |')
    lines.push('| --- | --- | ---: | --- | --- | --- | --- |')
    for (const s of r.segments) {
      const clock = startSec === null ? '—' : secToClock(startSec + Math.floor(s.startMs / 1000))
      const channel =
        s.ask.completeness === 'complete'
          ? 'phone+web'
          : s.ask.phone
            ? 'phone'
            : s.ask.web
              ? 'web'
              : 'no channel'
      const flags = [
        s.ask.sustainer ? 'sustainer' : null,
        s.ask.premium ? 'premium' : null,
        s.ask.matching ? 'match' : null,
        s.ask.deadline ? 'deadline' : null,
      ]
        .filter(Boolean)
        .join(', ')
      lines.push(
        `| ${formatDuration(s.startMs)} | ${clock} | ${formatDuration(s.durationMs)} | ${channel} | ${s.ask.amounts.map((n) => `$${n}`).join(' ') || '—'} | ${flags || '—'} | ${s.excerpt.replace(/\|/g, '\\|').slice(0, 140)} |`
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
      'host',
      'episode_id',
      'segment_start_s',
      'segment_seconds',
      'confidence',
      'channels',
      'amounts',
      'max_amount',
      'sustainer',
      'premium',
      'matching',
      'deadline',
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
          r.episode.host ?? '',
          r.episode.id,
          Math.round(s.startMs / 1000),
          Math.round(s.durationMs / 1000),
          s.tier,
          s.ask.completeness === 'complete' ? 'phone+web' : s.ask.phone ? 'phone' : s.ask.web ? 'web' : '',
          s.ask.amounts.join(' '),
          s.ask.amounts.length ? Math.max(...s.ask.amounts) : '',
          s.ask.sustainer ? 'yes' : '',
          s.ask.premium ? 'yes' : '',
          s.ask.matching ? 'yes' : '',
          s.ask.deadline ? 'yes' : '',
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

/** One row per asker — the drive scorecard, sortable in a spreadsheet. */
export function renderAskersCsv(report: PitchReport): string {
  const rows = [
    [
      'show_name',
      'show_group',
      'host',
      'airings',
      'pitches',
      'pitch_seconds',
      'airtime_seconds',
      'pct_pitch',
      'mean_pitch_seconds',
      'longest_pitch_seconds',
      'asks_phone_and_web',
      'asks_one_channel',
      'asks_no_channel',
      'asks_with_amount',
      'sustainer_asks',
      'premium_asks',
      'matching_asks',
      'deadline_asks',
      'usual_amount',
      'max_amount',
      'amounts',
    ].join(','),
  ]
  for (const a of report.byAsker) {
    rows.push(
      [
        `"${a.showName.replace(/"/g, '""')}"`,
        a.showGroup,
        `"${(a.host ?? '').replace(/"/g, '""')}"`,
        a.airings,
        a.segmentCount,
        Math.round(a.pitchMs / 1000),
        Math.round(a.airtimeMs / 1000),
        (a.pitchRatio * 100).toFixed(1),
        Math.round(a.meanSegmentMs / 1000),
        Math.round(a.longestSegmentMs / 1000),
        a.complete,
        a.partial,
        a.noChannel,
        a.withAmount,
        a.sustainerAsks,
        a.premiumAsks,
        a.matchingAsks,
        a.deadlineAsks,
        a.modalAmount ?? '',
        a.maxAmount ?? '',
        `"${a.amounts.join(' ')}"`,
      ].join(',')
    )
  }
  return rows.join('\n')
}

/** One row per aired hour — the "which hours had pitches" view. */
export function renderHoursCsv(report: PitchReport): string {
  const rows = [
    ['hour', 'pitches', 'pitch_seconds', 'airtime_seconds', 'pct_pitch', 'days_logged', 'days_unlogged', 'shows'].join(','),
  ]
  for (const h of report.byHour) {
    rows.push(
      [
        secToClock(h.hour * 3600),
        h.segmentCount,
        Math.round(h.pitchMs / 1000),
        Math.round(h.airtimeMs / 1000),
        (h.pitchRatio * 100).toFixed(1),
        h.daysWithAiring,
        h.daysUnlogged,
        `"${h.shows.join('; ').replace(/"/g, '""')}"`,
      ].join(',')
    )
  }
  return rows.join('\n')
}
