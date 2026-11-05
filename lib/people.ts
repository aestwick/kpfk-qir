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
    .filter((n) => {
      if (n.length < 4 || n.length > 40) return false
      if (/[0-9@]/.test(n)) return false
      if (!STARTS_UPPER.test(n)) return false
      if (ORG_WORD.test(n)) return false
      const words = n.split(/\s+/).length
      return words >= 2 && words <= 5
    })
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

/** Two spellings are the same person when they're very similar AND their last
 *  names agree closely (keeps "Greg Palast" apart from "Greg Grandin"). */
export function samePerson(a: string, b: string): boolean {
  const fa = foldName(a)
  const fb = foldName(b)
  if (fa === fb) return true
  const la = fa.split(' ').pop() ?? ''
  const lb = fb.split(' ').pop() ?? ''
  const fa0 = fa.split(' ')[0]
  const fb0 = fb.split(' ')[0]
  return nameSimilarity(fa, fb) >= 0.55 && nameSimilarity(la, lb) >= 0.45 && (fa0[0] === fb0[0])
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
