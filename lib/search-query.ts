// Pure query construction for transcript search (no DB, no network) — unit
// tested in search-query.test.ts.
//
// What a person types → a Postgres `to_tsquery('simple', …)` string, with each
// word widened to the spellings that actually occur in the station's
// transcripts (search_vocab_variants(), migration 046):
//   * accent/case variants    movilizacion → movilización
//   * plural / singular       immigrant → immigrants
//   * likely misspellings     Hartmann → Hartman (Whisper's usual spelling),
//                             Sojurner → Sojourner — only for rare/absent words,
//                             so common words never sprout look-alikes.
//
// Syntax (a forgiving subset of web search):
//   "exact phrase"   words in order (each word still accent/typo-forgiving)
//   -word            exclude
//   a OR b           either
//   anything else    all words must appear (AND); if nothing matches every word,
//                    the caller retries with `any` (most words, ranked) and
//                    tells the user it relaxed the match.

export interface ParsedQuery {
  /** Each clause is AND-ed; a clause is one word/phrase or an OR of several. */
  clauses: Clause[]
  /** Words or phrases to exclude. */
  excluded: Term[]
}

/** A phrase may carry `alt`: the token as Postgres indexes it whole ("90.7",
 *  "kpfk.org" — the default parser keeps dotted numbers/hosts as one token). */
export type Term = { kind: 'word'; word: string } | { kind: 'phrase'; words: string[]; alt?: string }
export interface Clause {
  anyOf: Term[]
}

export interface VariantRow {
  term: string
  variant: string
  ndoc: number
  kind: 'exact' | 'inflection' | 'fuzzy' | string
  sim: number
}

/** Words that carry no topic on their own (English + Spanish). Used only to
 *  pick the content words for the relaxed `any` query and to skip pointless
 *  vocabulary lookups — never to drop words from an exact phrase. */
const STOPWORDS = new Set(
  (
    'a an and are as at be been but by did do does for from had has have he her his i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this to too us was we ' +
    'were what when where which who why will with you your said says say about also just like very ' +
    'el la los las un una unos unas y o de del al en con por para que es son se lo le les su sus como mas ' +
    'pero ya muy hay fue era este esta estos estas ese esa'
  ).split(/\s+/)
)

const MAX_VARIANTS_PER_WORD = 6

/** Split text into lowercase word tokens the way the 'simple' parser roughly
 *  does (letters/digits, Unicode-aware; apostrophes and hyphens split). */
// Built with the constructor: the project's TS target rejects the `u` flag on
// regex literals, but every runtime we ship to supports Unicode classes.
const WORD_RE = new RegExp('[\\p{L}\\p{N}]+', 'gu')
const DOTTED_RE = new RegExp('^[\\p{L}\\p{N}]+(?:\\.[\\p{L}\\p{N}]+)+$', 'u')

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? []
}

/** Parse the search box. Never throws; an all-punctuation query parses empty. */
export function parseSearchQuery(input: string): ParsedQuery {
  const clauses: Clause[] = []
  const excluded: Term[] = []
  const re = /(-?)"([^"]*)"?|(\S+)/g
  let pendingOr = false
  let m: RegExpExecArray | null
  while ((m = re.exec(input))) {
    const negate = m[1] === '-'
    if (m[2] !== undefined) {
      const words = tokenize(m[2])
      if (!words.length) continue
      const term: Term = words.length === 1 ? { kind: 'word', word: words[0] } : { kind: 'phrase', words }
      if (negate) excluded.push(term)
      else pushTerm(term)
      continue
    }
    const raw = m[3]
    if (raw === 'OR' || raw === '|') {
      pendingOr = clauses.length > 0
      continue
    }
    const negate2 = raw.startsWith('-') && raw.length > 1
    const term = rawTerm(negate2 ? raw.slice(1) : raw)
    if (!term) continue
    if (negate2) excluded.push(term)
    else pushTerm(term)
  }
  return { clauses, excluded }

  function pushTerm(term: Term) {
    if (pendingOr && clauses.length) clauses[clauses.length - 1].anyOf.push(term)
    else clauses.push({ anyOf: [term] })
    pendingOr = false
  }
}

/** One unquoted token → a word, or a tiny phrase for "Fabara-Anelli" /
 *  "don't" (matching how it's indexed); dotted tokens keep their whole form. */
function rawTerm(raw: string): Term | null {
  const words = tokenize(raw)
  if (words.length === 1) return { kind: 'word', word: words[0] }
  if (!words.length) return null
  const dotted = raw.toLowerCase().match(DOTTED_RE)
  return dotted ? { kind: 'phrase', words, alt: dotted[0] } : { kind: 'phrase', words }
}

/** Every distinct word in the query worth a vocabulary lookup. */
export function lookupWords(q: ParsedQuery): string[] {
  const out = new Set<string>()
  for (const c of q.clauses)
    for (const t of c.anyOf) for (const w of t.kind === 'word' ? [t.word] : t.words) if (w.length >= 2) out.add(w)
  return Array.from(out)
}

/** Pick each word's spellings from the vocabulary rows: the word itself, its
 *  accent/case twins and inflections, then the closest look-alikes. */
export function chooseVariants(words: string[], rows: VariantRow[]): Map<string, string[]> {
  const byTerm = new Map<string, VariantRow[]>()
  for (const r of rows) {
    const list = byTerm.get(r.term) ?? []
    list.push(r)
    byTerm.set(r.term, list)
  }
  const rankKind = (k: string) => (k === 'exact' ? 0 : k === 'inflection' ? 1 : 2)
  const out = new Map<string, string[]>()
  for (const w of words) {
    const picked = [w]
    // Short words and filler words are matched as typed: their look-alikes
    // ("the" → "þe", "on" → "ón") only add noise.
    if (w.length > 3 && !STOPWORDS.has(w)) {
      const list = (byTerm.get(w) ?? [])
        .filter((r) => (r.kind === 'fuzzy' ? isPlausibleTypo(w, r) : r.kind === 'inflection' ? isPlausibleInflection(w, r.variant) : true))
        .sort((a, b) => rankKind(a.kind) - rankKind(b.kind) || b.sim - a.sim || b.ndoc - a.ndoc)
      for (const r of list) {
        if (picked.length >= MAX_VARIANTS_PER_WORD) break
        if (!picked.includes(r.variant)) picked.push(r.variant)
      }
    }
    out.set(w, picked)
  }
  return out
}

/** A plural/singular twin: a trailing "s"; or "es" after s/x/z/ch/sh
 *  ("boxes"/"box"), or after l/n/r/d/j on a stem of 5+ letters (Spanish:
 *  "movilizaciones"/"movilización", "ciudades"/"ciudad"). Keeps short names
 *  from shedding letters: "Jones" ≠ "jon", "Hayes" ≠ "hay", "Barnes" ≠ "barn". */
export function isPlausibleInflection(typed: string, variant: string): boolean {
  const fold = (x: string) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const [a, b] = [fold(typed), fold(variant)]
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  if (long === `${short}s`) return true
  if (long !== `${short}es`) return false
  return /(s|x|z|ch|sh)$/.test(short) || (short.length >= 5 && /[lnrdj]$/.test(short))
}

/** A trigram look-alike counts as a typo of the typed word only when it is
 *  about the same length and clearly similar ("hartmann" ↔ "hartman", not
 *  "prosegur" ↔ "prose"). */
function isPlausibleTypo(typed: string, r: VariantRow): boolean {
  return Math.abs(r.variant.length - typed.length) <= 2 && r.sim >= 0.5
}

/** Variants that differ from what was typed (for "Also matched: Hartman"). */
export function alsoMatched(variants: Map<string, string[]>): string[] {
  const out: string[] = []
  variants.forEach((list, typed) => {
    for (const v of list.slice(1)) if (v !== typed && !out.includes(v)) out.push(v)
  })
  return out
}

/** Quote one lexeme for to_tsquery. */
function lex(w: string): string {
  return `'${w.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`
}

function wordGroup(w: string, variants: Map<string, string[]>): string {
  const list = variants.get(w) ?? [w]
  return list.length === 1 ? lex(list[0]) : `(${list.map(lex).join(' | ')})`
}

function termQuery(t: Term, variants: Map<string, string[]>): string {
  if (t.kind === 'word') return wordGroup(t.word, variants)
  const phrase = `(${t.words.map((w) => wordGroup(w, variants)).join(' <-> ')})`
  return t.alt ? `(${lex(t.alt)} | ${phrase})` : phrase
}

export interface BuiltQuery {
  /** Every clause must match. */
  all: string
  /** The query's content words OR'd — for relaxed matching and for finding a
   *  moment when no single caption holds the whole query. Null when it would
   *  equal `all` (single word). */
  any: string | null
}

/** Build the tsquery strings. Returns null when there is nothing searchable. */
export function buildTsQuery(q: ParsedQuery, variants: Map<string, string[]> = new Map()): BuiltQuery | null {
  if (!q.clauses.length) return null
  const parts = q.clauses.map((c) => {
    const terms = c.anyOf.map((t) => termQuery(t, variants))
    return terms.length === 1 ? terms[0] : `(${terms.join(' | ')})`
  })
  // Exclusions match as typed (no variants); a phrase is excluded as a phrase.
  const not = q.excluded.map((t) => `!${termQuery(t, new Map())}`)
  const all = [...parts, ...not].join(' & ')

  const content = lookupWords(q).filter((w) => !STOPWORDS.has(w))
  const anyWords = content.length ? content : lookupWords(q)
  const any = anyWords.length > 1 || q.clauses.some((c) => c.anyOf.some((t) => t.kind === 'phrase'))
    ? (() => {
        const ors = anyWords.map((w) => wordGroup(w, variants))
        // `&` binds tighter than `|` in tsquery: parenthesise the OR group
        // before attaching exclusions, or "-x" would only guard the last word.
        const group = ors.length > 1 && not.length ? `(${ors.join(' | ')})` : ors.join(' | ')
        return [group, ...not].join(' & ')
      })()
    : null
  return { all, any: any && any !== all ? any : null }
}

/** Reciprocal-rank fusion of ranked id lists (k=60, the usual constant). */
export function reciprocalRankFusion(lists: number[][], k = 60): { id: number; score: number }[] {
  const score = new Map<number, number>()
  for (const list of lists) list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
  return Array.from(score, ([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || a.id - b.id)
}
