// Scoring for the names benchmark (scripts/benchmark-names.ts) — pure.
//
// The question it answers: "of the times a known name came out in the
// transcript, how often was it spelled right?" — using human-confirmed names
// as the answer key and the misspellings measured on real KPFK transcripts as
// the wrong forms. Plus two safety checks for the vocabulary hint: did it
// replace real speech (lost words), and did it make names appear that nobody
// said (hint names showing up on music)?

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whole-word, case-insensitive occurrences of a phrase (spaces flexible). */
export function countPhrase(text: string, phrase: string): number {
  const words = phrase.trim().split(/\s+/).map(escape)
  if (!words.length || !words[0]) return 0
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
  return (text.match(re) ?? []).length
}

export interface NameExpectation {
  name: string
  /** Known wrong spellings (measured on stored transcripts). */
  variants: string[]
}

export interface NameScore {
  name: string
  right: number
  wrong: number
}

export function scoreNames(text: string, expected: NameExpectation[]): NameScore[] {
  return expected.map((e) => ({
    name: e.name,
    right: countPhrase(text, e.name),
    wrong: e.variants.reduce((n, v) => n + countPhrase(text, v), 0),
  }))
}

/** right / (right + wrong) over all scores; null when no name came out at all. */
export function accuracy(scores: NameScore[]): number | null {
  const right = scores.reduce((n, s) => n + s.right, 0)
  const wrong = scores.reduce((n, s) => n + s.wrong, 0)
  return right + wrong ? right / (right + wrong) : null
}

// Built with the constructor: the project targets ES5, which rejects a /u literal.
const NON_WORD = new RegExp("[^\\p{L}\\p{N}' ]+", 'gu')

const words = (t: string) =>
  t
    .toLowerCase()
    .replace(NON_WORD, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * Words of the baseline that the hinted run REPLACED in long stretches — the
 * failure seen with sentence-style prompts (a spoken bio turned into garbage).
 * Word-level LCS; counts baseline words inside unmatched runs of `minRun`+.
 * Small spelling fixes (one or two words) never count.
 */
export function lostWords(baseline: string, candidate: string, minRun = 12): number {
  const a = words(baseline)
  const b = words(candidate)
  const n = a.length
  const m = b.length
  if (!n) return 0
  // LCS table, row-by-row with a direction matrix for the backtrack.
  const dirs = new Uint8Array((n + 1) * (m + 1))
  let prev = new Uint32Array(m + 1)
  let cur = new Uint32Array(m + 1)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1
        dirs[i * (m + 1) + j] = 1
      } else if (prev[j] >= cur[j - 1]) {
        cur[j] = prev[j]
        dirs[i * (m + 1) + j] = 2
      } else {
        cur[j] = cur[j - 1]
        dirs[i * (m + 1) + j] = 3
      }
    }
    ;[prev, cur] = [cur, prev]
    cur.fill(0)
  }
  // Walk back marking which baseline words were matched.
  const matched = new Uint8Array(n)
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const d = dirs[i * (m + 1) + j]
    if (d === 1) {
      matched[i - 1] = 1
      i--
      j--
    } else if (d === 2) i--
    else j--
  }
  let lost = 0
  let run = 0
  for (let k = 0; k <= n; k++) {
    if (k < n && !matched[k]) run++
    else {
      if (run >= minRun) lost += run
      run = 0
    }
  }
  return lost
}
