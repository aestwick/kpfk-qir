// Triage tiers for compliance flags. Pure: shared by the triage API and its
// tests. The point is order — a reviewer with an hour should spend it on the
// few flags the FCC could actually act on, and close the rest by rule.
//
//   A  Listen now   aired 6am–10pm with a high-risk word, or any indecency
//                   flag in those hours
//   B  Glance       aired 6am–10pm, any other listed word (slurs, Spanish,
//                   milder words)
//   C  Safe harbor  aired 10pm–6am, when the FCC allows indecent and profane
//                   (never obscene) speech; acknowledge, keep for the record
//   D  Other        not an on-air language question: sponsor / payola,
//                   technical, station ID, rerun
//
// "High-risk" means the words behind FCC profanity enforcement (the seven
// words and their forms). The FCC publishes no list and context decides —
// news use, fleeting expletives — so this ranks flags for a human; it never
// clears or convicts anything on its own.

import { restrictedHoursCheck, wordPattern } from './compliance-match'

export type Tier = 'A' | 'B' | 'C' | 'D'

export const TIERS: Tier[] = ['A', 'B', 'C', 'D']

export const TIER_LABELS: Record<Tier, { title: string; rule: string }> = {
  A: { title: 'Listen now', rule: '6am–10pm, high-risk word or indecency' },
  B: { title: 'Glance', rule: '6am–10pm, other listed words' },
  C: { title: 'Safe harbor', rule: '10pm–6am, allowed by the FCC' },
  D: { title: 'Other checks', rule: 'Sponsor, payola, technical, station ID, rerun' },
}

// Stems of the high-risk words. "fuck" and "shit" count anywhere in a word,
// since they form compounds ("motherfucking", "bullshit"); the rest only at the
// start of a word, so "petits" or "mississippi"-style lookalikes don't count.
export const HIGH_RISK_ANYWHERE = ['fuck', 'shit']
export const HIGH_RISK_PREFIXES = ['cunt', 'cocksuck', 'tits', 'piss']

const LANGUAGE_TYPES = new Set(['profanity', 'indecency'])

/** The listed word a word-list flag was raised for (`"shit" detected …`). */
export function flagTerm(details: string | null | undefined): string | null {
  const m = details?.match(/^"([^"]+)" detected/)
  return m ? m[1] : null
}

/** Whether a word (or, with no term, an excerpt) contains a high-risk word. */
export function isHighRisk(text: string | null | undefined): boolean {
  if (!text) return false
  const tokens = text.toLowerCase().split(new RegExp('[^\\p{L}\\p{N}*]+', 'u'))
  return tokens.some((t) => HIGH_RISK_ANYWHERE.some((s) => t.includes(s)) || HIGH_RISK_PREFIXES.some((s) => t.startsWith(s)))
}

export interface TierInput {
  flag_type: string
  details: string | null
  excerpt: string | null
  timestamp_seconds: number | null
  /** The episode's start time, 'HH:MM[:SS]' station-local. */
  air_start: string | null
  /** The episode's length in minutes. */
  duration: number | null
}

export function tierOf(f: TierInput): Tier {
  if (!LANGUAGE_TYPES.has(f.flag_type)) return 'D'
  const restricted = restrictedHoursCheck(f.air_start, f.duration)(f.timestamp_seconds)
  if (!restricted) return 'C'
  if (f.flag_type === 'indecency') return 'A'
  // Word-list flags name their word; AI flags don't, so read their excerpt.
  const term = flagTerm(f.details)
  return isHighRisk(term ?? f.excerpt) ? 'A' : 'B'
}

/** Wall-clock minute of the day a flag aired (air start + offset), or null. */
export function airedMinute(airStart: string | null, offsetSec: number | null): number | null {
  if (!airStart) return null
  const [h, m] = airStart.split(':').map(Number)
  if (Number.isNaN(h)) return null
  return ((h * 60 + (m || 0) + Math.floor((offsetSec ?? 0) / 60)) % 1440 + 1440) % 1440
}

/** Index of the flagged word in an excerpt, for highlighting. */
export function termSpan(excerpt: string | null, term: string | null): [number, number] | null {
  if (!excerpt || !term) return null
  const m = wordPattern(term).exec(excerpt)
  return m ? [m.index, m.index + m[0].length] : null
}

/** Statuses that still need a decision. */
export const OPEN_STATUSES = new Set(['suggested', 'investigating'])
