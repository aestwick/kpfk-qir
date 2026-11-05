// People (hosts & guests): parsing the free-text host/guest fields and merging
// spelling variants. Pure — unit-tested in people.test.ts.
//
// The SQL side (search_people(), migration 046) does the heavy lifting over the
// whole archive; this module merges its per-spelling rows into one person
// ("Gerald Horn" / "Gerald Horne" / "Dr. Gerald Horne" → one entry) and splits
// guest strings for the Show report's guest list using the same rules.

/** Strip accents + lowercase (JS twin of SQL qir_fold). */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Constructor form: the TS target rejects the `u` flag on regex literals.
const STARTS_UPPER = new RegExp('^\\p{Lu}', 'u')
// Affiliation fragments that survive the comma split ("…, Amherst College").
const ORG_WORD = /\b(college|university|universidad|institute|instituto|school|science|sciences|studies|center|centre|foundation|department|council|coalition|committee|network|project|association|society|union|party|press|magazine|news|times|journal|church|alliance|campaign|organization|organizing|agency|office|program|programme|radio|tv|records|band|orchestra)\b/i

const HONORIFIC = /^(dr|rev|reverend|prof|professor|congressman|congresswoman|rep|sen|senator|col|colonel|mr|mrs|ms|judge|mayor|councilmember|attorney)\.?\s+/i

/** Split a host/guest field into individual names (mirrors qir_episode_people). */
export function splitPeople(field: string | null | undefined): string[] {
  if (!field) return []
  return field
    .split(/\s*(?:;|,|&|\/|\s+and\s+|\s+y\s+)\s*/)
    .map((p) => p.replace(/\([^)]*\)/g, '').replace(HONORIFIC, '').replace(/^[\s.-]+|[\s.-]+$/g, ''))
    .filter(isLikelyPersonName)
}

/** Heuristic: does a split-out fragment look like a person's name (2–5 words,
 *  capitalised, no digits, not an organisation/affiliation)? */
export function isLikelyPersonName(n: string): boolean {
  if (n.length < 4 || n.length > 40) return false
  if (/[0-9@]/.test(n)) return false
  if (!STARTS_UPPER.test(n)) return false
  if (ORG_WORD.test(n)) return false
  const words = n.split(/\s+/).length
  return words >= 2 && words <= 5
}

/** pg_trgm-style trigram set (words padded with two leading + one trailing space). */
function trigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of foldName(s).split(/[^a-z0-9]+/).filter(Boolean)) {
    const p = `  ${w} `
    for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3))
  }
  return out
}

/** Trigram similarity in [0,1] (same definition as pg_trgm similarity()). */
export function nameSimilarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (!ta.size || !tb.size) return 0
  let shared = 0
  ta.forEach((t) => {
    if (tb.has(t)) shared++
  })
  return shared / (ta.size + tb.size - shared)
}

/** Rough sound-alike key: the spellings transcribers and producers mix up
 *  (c/k, ph/f, th/t, doubled letters, a silent trailing e) collapse together,
 *  so "Thom Hartmann" ~ "Tom Hartman" and "David Corn" ~ "David Korn". */
export function phoneticKey(name: string): string {
  return foldName(name)
    .split(' ')
    .map((w) =>
      w
        .replace(/ph/g, 'f')
        .replace(/th/g, 't')
        .replace(/ck/g, 'k')
        .replace(/c(?=[aou]|$|[^ehiy])/g, 'k')
        .replace(/z/g, 's')
        .replace(/(.)\1+/g, '$1')
        .replace(/(?<=..)e$/, '')
    )
    .join(' ')
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** First names must be the same name: sound-alike ("Thom"/"Tom", "Kathy"/
 *  "Cathy"), or a one-letter swap inside a longer name of the same length
 *  ("Jeremey"/"Jeremay"). Added/dropped letters and ending changes are
 *  different names ("Michael"/"Michelle", "Maria"/"Mario", "Carla"/"Carlos"). */
function sameFirstName(a: string, b: string): boolean {
  const pa = phoneticKey(a)
  const pb = phoneticKey(b)
  if (pa === pb) return true
  return pa.length === pb.length && pa.length >= 6 && editDistance(pa, pb) === 1 && pa[pa.length - 1] === pb[pb.length - 1]
}

/** Two spellings are the same person when their first names are the same name
 *  and their last names are close, as written or as they sound ("Tom Hartman"
 *  = "Thom Hartmann", "David Korn" = "David Corn"; "Greg Palast" ≠ "Greg
 *  Grandin", "Michael Brown" ≠ "Michelle Brown"). */
export function samePerson(a: string, b: string): boolean {
  const fa = foldName(a)
  const fb = foldName(b)
  if (fa === fb) return true
  const wa = fa.split(' ')
  const wb = fb.split(' ')
  if (!sameFirstName(wa[0], wb[0])) return false
  const la = wa[wa.length - 1]
  const lb = wb[wb.length - 1]
  return nameSimilarity(la, lb) >= 0.45 || nameSimilarity(phoneticKey(la), phoneticKey(lb)) >= 0.45
}

export interface PersonRow {
  folded: string
  name: string
  appearances: number
  as_host: number
  as_guest: number
  first_date: string | null
  last_date: string | null
  shows: string[] | null
  score: number
}

export interface Person {
  /** Most frequent spelling. */
  name: string
  /** Every folded spelling merged into this person (pass to person_appearances). */
  spellings: string[]
  /** Display spellings other than `name`. */
  variants: string[]
  appearances: number
  asHost: number
  asGuest: number
  firstDate: string | null
  lastDate: string | null
  shows: string[]
  score: number
}

/** Merge per-spelling rows into people, best match first. Appearance counts are
 *  summed (an episode spelled two ways in host and guest is rare enough not to
 *  matter for a count; the detail list is de-duplicated by episode). */
export function mergePeople(rows: PersonRow[]): Person[] {
  const people: Person[] = []
  const sorted = rows.slice().sort((a, b) => Number(b.appearances) - Number(a.appearances))
  for (const r of sorted) {
    const p = people.find((x) => samePerson(x.name, r.name))
    if (!p) {
      people.push({
        name: r.name,
        spellings: [r.folded],
        variants: [],
        appearances: Number(r.appearances),
        asHost: Number(r.as_host),
        asGuest: Number(r.as_guest),
        firstDate: r.first_date,
        lastDate: r.last_date,
        shows: (r.shows ?? []).slice(),
        score: Number(r.score),
      })
      continue
    }
    p.spellings.push(r.folded)
    if (!p.variants.includes(r.name) && r.name !== p.name) p.variants.push(r.name)
    p.appearances += Number(r.appearances)
    p.asHost += Number(r.as_host)
    p.asGuest += Number(r.as_guest)
    if (r.first_date && (!p.firstDate || r.first_date < p.firstDate)) p.firstDate = r.first_date
    if (r.last_date && (!p.lastDate || r.last_date > p.lastDate)) p.lastDate = r.last_date
    for (const s of r.shows ?? []) if (!p.shows.includes(s)) p.shows.push(s)
    p.score = Math.max(p.score, Number(r.score))
  }
  return people.sort((a, b) => b.score - a.score || b.appearances - a.appearances)
}

/** Order matches for what was typed: best score first; on a tie, the person
 *  whose name appears earliest in the query ("David Corn Mother Jones" → David
 *  Corn before Mother Jones — people type the name first, the affiliation after). */
export function rankForQuery(people: Person[], query: string): Person[] {
  const fq = foldName(query)
  const pos = (p: Person) => {
    const first = foldName(p.name).split(' ')[0]
    const i = fq.indexOf(first)
    return i < 0 ? Infinity : i
  }
  return people.slice().sort((a, b) => b.score - a.score || pos(a) - pos(b) || b.appearances - a.appearances)
}
