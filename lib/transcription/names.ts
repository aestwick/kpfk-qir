// Person-name helpers — pure. Shared by the vocabulary hint (names from
// Confessor host/guest fields), the nightly CMS host sync, and the miner.

// Words that are never part of a person's name in the free-text host/guest
// fields producers type ("Various hosts", "With the Pacifica News Dept").
const NON_NAME = /^(various|varias|variouis|many)\b|^(tbd|tba|n\/?a|none|no guest|guest host|host|hosts|co-?host|producer|collective|staff)$/i

// Words that start a sentence and so come out capitalized next to a surname
// ("Your Harrison", "The Harrison") — never a first name.
const SENTENCE_WORDS = new Set(
  'a an and as at but by for from he her his i if in is it its my no not of on or our she so that the their them they this to us we what when where who why with you your yes hey oh ok okay well now then here there mr mrs ms dr'.split(' '),
)

const NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'van', 'von', 'da', 'di', 'du', 'le', 'bin', 'ibn'])

/** Free text that reads like prose, not a name: a sentence word ("of", "the")
 *  or more than one lowercase word that isn't a name particle. */
function readsLikeProse(name: string): boolean {
  const words = name.split(' ')
  if (words.some((w) => SENTENCE_WORDS.has(w.toLowerCase()) && !/^[A-Z]/.test(w))) return true
  return words.filter((w) => /^[a-z]/.test(w) && !NAME_PARTICLES.has(w)).length > 1
}

/**
 * Split a free-text host/guest field into individual names:
 * "Harvey Wasserman & Kevin Kamps" → ["Harvey Wasserman", "Kevin Kamps"].
 * Splits on commas, semicolons, "&", "+", "/", " and ", " y " (Spanish) and
 * newlines; strips parentheticals ("(Guest Host)"), "Dr."/"Prof." titles stay
 * attached only as written. Drops entries with digits, long phrases (titles and
 * bios: more than 5 words), and placeholders like "Various".
 */
export function splitPersonNames(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  const pieces = raw
    .replace(/\([^)]*\)/g, ' ')
    .split(/[,;&+/\n]|\s+and\s+|\s+y\s+/i)
  for (const piece of pieces) {
    const name = piece.replace(/["“”]/g, '').replace(/\s+/g, ' ').replace(/^[\s"'“”-]+|[\s"'“”.:-]+$/g, '').trim()
    if (name.length < 2 || name.length > 60) continue
    if (/\d|@|https?:/i.test(name)) continue
    if (name.split(' ').length > 5) continue
    if (NON_NAME.test(name)) continue
    if (readsLikeProse(name)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** A name worth mining variants for: at least two words (a first name alone
 *  is nearly always also a common word or another person). */
export function isMultiWordName(name: string): boolean {
  return name.trim().split(/\s+/).length >= 2
}

/** Is the miner's candidate "variant" plausibly a person's name? Rejects
 *  pairs where either word is a sentence word ("Your Harrison"). */
export function looksLikePersonName(variant: string): boolean {
  const words = variant.trim().split(/\s+/)
  if (words.length < 2) return false
  return words.every((w) => !SENTENCE_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, '')))
}
