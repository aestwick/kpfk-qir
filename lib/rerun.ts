// Rerun detection: is this episode's transcript mostly a copy of an earlier
// one from the same show? Pure — the compliance worker loads rows and stores
// fingerprints; this does the text work (unit-tested in rerun.test.ts).
//
// Fingerprint = a deterministic ~1-in-8 sample of the transcript's 4-word
// shingles, hashed to 32-bit ints. Two transcriptions of the same audio are
// never byte-identical (different chunk boundaries, provider, a few misheard
// words), but they share most 4-word runs; two different episodes of a talk
// show share almost none. Sampling by hash value (not position) means both
// copies keep the SAME shingles, so the overlap of the samples estimates the
// overlap of the full sets at a few KB per episode.
//
// Containment, not Jaccard: "how much of THIS episode was already aired" —
// a rerun that was trimmed or padded with a new intro still scores high.
//
// Disclosure is only checked on episodes that already matched: an on-air
// phrase like "originally aired" / "retransmisión" that does NOT also appear
// in the original (an announcement added for the rerun, not a line the host
// said the first time).

/** Bump when the fingerprint algorithm changes: stored rows recompute. */
export const FINGERPRINT_VERSION = 1

/** Fraction of an episode's shingles found in an earlier one to call it a rerun.
 *  Measured on live KPFK (Nov 2026): different episodes of the same show
 *  score 0.00–0.03; known reruns 0.84–0.95; partial reruns 0.5–0.6. */
export const RERUN_THRESHOLD = 0.8

/** Words per shingle. */
export const SHINGLE_WORDS = 4

/** Keep a shingle when hash % SAMPLE_MOD === 0 (≈1 in 8). */
export const SAMPLE_MOD = 8

/** Below this many sampled shingles (~400 words) a match means little. */
export const MIN_FINGERPRINT = 50

/** How far back to look for the original airing. */
export const LOOKBACK_DAYS = 180

/** Same-show feeds starting this close together are one airing, not a rerun
 *  (mirrors SAME_AIRING_MINUTES in lib/broadcast-day.ts). */
export const SAME_AIRING_MINUTES = 5

/** Lowercase, strip accents, keep letters/digits — so "Médico," == "medico". */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** FNV-1a, 32-bit unsigned. Stable across runs/machines (fingerprints are stored). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Sorted, de-duplicated sample of shingle hashes. */
export function fingerprint(text: string): number[] {
  const words = normalizeWords(text)
  const out = new Set<number>()
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) {
    const h = fnv1a(words.slice(i, i + SHINGLE_WORDS).join(' '))
    if (h % SAMPLE_MOD === 0) out.add(h)
  }
  return Array.from(out).sort((a, b) => a - b)
}

/** |a ∩ b| / |a| over two sorted fingerprints. */
export function containment(a: number[], b: number[]): number {
  if (a.length === 0) return 0
  let i = 0
  let j = 0
  let hit = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      hit++
      i++
      j++
    } else if (a[i] < b[j]) i++
    else j++
  }
  return hit / a.length
}

export interface PriorAiring {
  id: number
  air_date: string | null
  air_start: string | null
  fingerprint: number[]
}

export interface RerunMatch {
  prior: PriorAiring
  score: number
}

/** Best-scoring earlier airing at or above the threshold, or null. */
export function bestMatch(fp: number[], priors: PriorAiring[], threshold = RERUN_THRESHOLD): RerunMatch | null {
  if (fp.length < MIN_FINGERPRINT) return null
  let best: RerunMatch | null = null
  for (const prior of priors) {
    if (prior.fingerprint.length < MIN_FINGERPRINT) continue
    const score = containment(fp, prior.fingerprint)
    if (score >= threshold && (!best || score > best.score)) best = { prior, score }
  }
  return best
}

function minutesOf(t: string | null): number | null {
  if (!t) return null
  const [h, m] = t.split(':').map(Number)
  return Number.isNaN(h) ? null : h * 60 + (m || 0)
}

/** Whether `prior` aired before `ep` — and is not the same airing on another
 *  feed (same date, start within SAME_AIRING_MINUTES). Null start times only
 *  count when the dates differ. */
export function airedEarlier(
  ep: { air_date: string | null; air_start: string | null },
  prior: { air_date: string | null; air_start: string | null },
): boolean {
  if (!ep.air_date || !prior.air_date) return false
  if (prior.air_date !== ep.air_date) return prior.air_date < ep.air_date
  const a = minutesOf(ep.air_start)
  const b = minutesOf(prior.air_start)
  if (a == null || b == null) return false
  return a - b > SAME_AIRING_MINUTES
}

// Rerun announcements, English + Spanish. Deliberately specific: a word like
// "repeat" or "best of" turns up in ordinary speech far too often.
const DISCLOSURE_PATTERNS: RegExp[] = [
  /\boriginally (aired|broadcast|recorded|heard)\b/i,
  /\b(previously|pre-?)\s?recorded\b/i,
  /\b(was|were) recorded (earlier|on|last|back)\b/i,
  /\brebroadcast\b/i,
  /\b(has|was|were) previously aired\b/i,
  /\bre-?airing\b/i,
  /\b(an |this )?encore (presentation|broadcast|edition|performance of (the|our) (show|program))\b/i,
  /\b(this is|you're (listening to|hearing)) a (rerun|repeat|replay)\b/i,
  /\b(a|this) (rerun|repeat|replay) of\b/i,
  /\bfrom (our|the) archives?\b/i,
  /\bretransmisi[oó]n\b/i,
  /\b(programa|emisi[oó]n|entrevista) (grabad[oa]|pregrabad[oa])\b/i,
  /\bpregrabad[oa]\b/i,
  /\b(transmitid[oa]|emitid[oa]|grabad[oa]) (originalmente|previamente|anteriormente)\b/i,
  /\b(originalmente|previamente) (transmitid[oa]|emitid[oa]|grabad[oa])\b/i,
  // Not bare "una repetición": "es como una repetición" is ordinary speech
  // (seen on a live Perspectiva transcript).
  /\b(esta es|este programa es) una (repetici[oó]n|retransmisi[oó]n)\b/i,
]

export interface Disclosure {
  phrase: string
  index: number
}

/** Rerun announcements in `transcript` that the original did NOT also contain
 *  — i.e. ones added for the rerun. Compared on normalized text so case,
 *  accents and punctuation from a different transcription don't matter. */
export function findDisclosures(transcript: string, originalTranscript: string): Disclosure[] {
  const original = ` ${normalizeWords(originalTranscript).join(' ')} `
  const found: Disclosure[] = []
  for (const re of DISCLOSURE_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of transcript.matchAll(g)) {
      const phrase = m[0]
      const norm = normalizeWords(phrase).join(' ')
      if (norm && !original.includes(` ${norm} `)) found.push({ phrase, index: m.index ?? 0 })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

export interface RerunFlagFields {
  severity: 'info' | 'warning'
  /** The on-air announcement in context (disclosed only) — also the flag's identity. */
  excerpt: string | null
  /** The announcement phrase itself, for locating it in the captions. */
  disclosureText: string | null
  details: string
}

/** Flag content for a matched rerun.
 *   undisclosed, earlier day → warning (the case a reviewer should hear)
 *   undisclosed, same day    → info (a scheduled repeat slot, e.g. DN 7am → 4pm)
 *   disclosed                → info, quoting the announcement
 *  Never critical: a rerun is not an FCC violation by itself, so it must not
 *  hold an episode out of the QIR when blocking is on. */
export function rerunFlagFields(
  ep: { air_date: string | null },
  match: RerunMatch & { prior: PriorAiring & { show_name?: string | null } },
  transcript: string,
  disclosures: Disclosure[],
): RerunFlagFields {
  const pct = Math.round(match.score * 100)
  const p = match.prior
  const when = `${p.air_date ?? '?'}${p.air_start ? ` ${p.air_start.slice(0, 5)}` : ''}`
  const what = `${p.show_name ? `${p.show_name} ` : ''}aired ${when} (episode #${p.id})`
  const sameDay = !!ep.air_date && ep.air_date === p.air_date
  if (disclosures.length > 0) {
    const d = disclosures[0]
    const excerpt = transcript.slice(Math.max(0, d.index - 60), Math.min(transcript.length, d.index + d.phrase.length + 60)).trim()
    return {
      severity: 'info',
      excerpt,
      disclosureText: d.phrase,
      details: `Disclosed rerun: ${pct}% of this transcript matches ${what}. Announced on air: "${d.phrase}".`,
    }
  }
  return {
    severity: sameDay ? 'info' : 'warning',
    excerpt: null,
    disclosureText: null,
    details: sameDay
      ? `Same-day repeat, no rerun announcement found: ${pct}% of this transcript matches ${what}.`
      : `Undisclosed rerun: ${pct}% of this transcript matches ${what}, and no rerun announcement was found.`,
  }
}
