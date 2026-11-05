// Transcript correction rules — pure functions shared by the transcribe worker
// (new transcripts), the corrections worker (re-applying rules to STORED
// transcripts), and the Settings "Test corrections" box, so all three apply a
// rule exactly the same way. Rules are JavaScript regexes: never translate one
// to SQL to apply it (Postgres reads `\b` as a backspace) — SQL is only ever
// used as a superset prefilter (see toPrefilterPattern).

export interface Correction {
  wrong: string
  correct: string
  caseSensitive: boolean
  isRegex: boolean
  /** When set, the rule applies ONLY to this episode (migration 006). */
  episodeId?: number | null
  /** When set, the rule applies only to this show — every feed in its
   *  show_group (migration 047). Null = station-wide. */
  showKey?: string | null
}

/** Which show group a show key belongs to (lib/shows.ts#showGroupKey). A key
 *  missing from the map is its own group. */
export type ShowGroupLookup = (showKey: string) => string

/**
 * Narrow a station's rule list to the ones that apply to one episode:
 * station-wide rules, rules scoped to this episode, and rules scoped to this
 * episode's show (any feed of the same show group). An episode- or show-scoped
 * rule must never leak onto other episodes — "Nick Richard → Nick Richert" is
 * right on Bike Talk and wrong everywhere else.
 */
export function correctionsForEpisode<T extends Correction>(
  corrections: T[],
  episodeId: number,
  episodeShowKey?: string | null,
  groupOf?: ShowGroupLookup,
): T[] {
  const group = (key: string) => (groupOf ? groupOf(key) : key.toLowerCase())
  const myGroup = episodeShowKey ? group(episodeShowKey) : null
  return corrections.filter((c) => {
    if (c.episodeId != null) return c.episodeId === episodeId
    if (c.showKey) return myGroup != null && group(c.showKey) === myGroup
    return true
  })
}

function ruleRegex(c: Correction): RegExp | null {
  const flags = c.caseSensitive ? 'g' : 'gi'
  if (!c.isRegex) {
    return new RegExp(c.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
  }
  try {
    return new RegExp(c.wrong, flags)
  } catch (err) {
    console.warn(
      `[corrections] Skipping invalid regex correction "${c.wrong}":`,
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** Apply rules in order to a piece of text. Invalid regexes are skipped. */
export function applyCorrections(text: string, corrections: Correction[]): string {
  let result = text
  for (const c of corrections) {
    if (!c.wrong) continue
    const re = ruleRegex(c)
    if (re) result = result.replace(re, c.correct)
  }
  return result
}

/** Does this rule match anywhere in the text? */
export function correctionMatches(text: string, c: Correction): boolean {
  if (!c.wrong) return false
  const re = ruleRegex(c)
  if (!re) return false
  re.lastIndex = 0
  return re.test(text)
}

/**
 * True when re-applying the rule to its own output changes it again — e.g.
 * "Cary" → "Cary Harrison" would turn into "Cary Harrison Harrison" on every
 * re-run. Such a rule is fine at transcription time (it runs once) but must
 * NOT be re-applied to stored transcripts.
 */
export function isSelfReapplying(c: Correction): boolean {
  if (!c.correct) return false
  return correctionMatches(c.correct, c)
}

const VTT_TIMING = /^\s*\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/
const VOICE_PREFIX = /^(<v [^>]*>)/

/**
 * Apply rules to the cue TEXT of a stored WebVTT file, leaving the header,
 * cue numbers, timing lines and `<v Speaker N>` voice tags untouched (a rule
 * must never rewrite a timestamp or a speaker label).
 */
export function applyCorrectionsToVtt(vtt: string, corrections: Correction[]): string {
  if (!vtt || !corrections.length) return vtt
  const lines = vtt.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    if (i === 0 && trimmed.startsWith('WEBVTT')) continue
    if (/^\d+$/.test(trimmed)) continue
    if (VTT_TIMING.test(line)) continue
    if (trimmed.startsWith('NOTE')) continue
    const m = line.match(VOICE_PREFIX)
    const prefix = m ? m[1] : ''
    lines[i] = prefix + applyCorrections(line.slice(prefix.length), corrections)
  }
  return lines.join('\n')
}

/**
 * A Postgres regex (for PostgREST `match` / `imatch`) that matches at least
 * every transcript the JS rule would change — used only to narrow which stored
 * transcripts to fetch. Returns null when no safe superset can be expressed;
 * the caller then scans every transcript in scope.
 */
export function toPrefilterPattern(c: Correction): string | null {
  if (!c.wrong) return null
  if (!c.isRegex) return c.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // JS-only syntax Postgres would reject or read differently: lookbehind,
  // named groups, unicode property escapes, inline flags.
  if (/\(\?<[=!]|\(\?<[A-Za-z]|\\[pPk]|\(\?[a-z]/.test(c.wrong)) return null
  // \b (word boundary in JS) is a backspace in Postgres; \y is its boundary.
  // \B has no Postgres twin — drop it (dropping an anchor only widens a match).
  return c.wrong.replace(/\\b/g, '\\y').replace(/\\B/g, '')
}

const ESCAPE = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The rule a person gets when they approve a suggested correction: a
 * whole-word, case-insensitive match of the exact variant (any run of spaces
 * between words), replaced by the correct spelling.
 */
export function buildVariantRule(variant: string, correct: string): Pick<Correction, 'wrong' | 'correct' | 'caseSensitive' | 'isRegex'> {
  const trimmed = variant.trim()
  const words = trimmed.split(/\s+/).map(ESCAPE)
  // JS \b only knows ASCII word characters: a boundary next to "é" never
  // matches, so only anchor an end that is an ASCII word character.
  const lead = /^\w/.test(trimmed) ? '\\b' : ''
  const tail = /\w$/.test(trimmed) ? '\\b' : ''
  return {
    wrong: `${lead}${words.join('\\s+')}${tail}`,
    correct: correct.trim(),
    caseSensitive: false,
    isRegex: true,
  }
}

/** Why a rule can't be saved, or null when it's fine. Shared by the API
 *  (create/edit/approve) so a broken regex never reaches a transcript. */
export function correctionError(c: Pick<Correction, 'wrong' | 'correct' | 'isRegex'>): string | null {
  if (!c.wrong?.trim()) return 'The "wrong" text is required'
  if (c.correct == null || !c.correct.trim()) return 'The "correct" text is required'
  if (c.isRegex) {
    try {
      new RegExp(c.wrong)
    } catch (err) {
      return `Invalid regex: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  return null
}
