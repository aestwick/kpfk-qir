import { XMLParser } from 'fast-xml-parser'

// Single parser config shared across RSS consumers (ingest + archive lookup), so
// CDATA handling and the item-is-always-an-array rule stay identical everywhere.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  isArray: (name) => name === 'item',
})

// Named HTML entities seen in (or likely for) Pacifica feed categories/titles —
// the XML predefined five plus the common Latin set for Spanish-language shows.
// The XML parser decodes these on plain text nodes, but CDATA content is passed
// through verbatim (entities are not processed inside CDATA), so a CDATA-wrapped
// "Espa&ntilde;ol" / "Arts &amp; Entertainment" would survive un-decoded without
// this. Numeric refs (&#243; / &#xF3;) are handled generically below.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ntilde: 'ñ', Ntilde: 'Ñ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  uuml: 'ü', Uuml: 'Ü', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
}

/**
 * Decode HTML/XML character references in a string: named entities (the set
 * above), decimal (`&#243;`) and hex (`&#xF3;`) numeric refs. Conservative —
 * only well-formed `&…;` tokens are touched, so stray ampersands ("AT&T",
 * "Cats & Dogs") are left alone. Idempotent on already-decoded text.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match
  })
}

/**
 * Unwrap a possibly-CDATA-wrapped RSS text node to a trimmed, entity-decoded
 * string (or null). RSS titles/categories arrive either as a plain string or,
 * when CDATA-wrapped, as an object carrying `__cdata` (see the parser config
 * above). Entities are decoded here so CDATA-wrapped nodes (which the parser
 * leaves encoded) match the plain-text path — see migration 039.
 */
export function rssText(node: unknown): string | null {
  if (node == null) return null
  if (typeof node === 'object') {
    const cdata = (node as { __cdata?: unknown }).__cdata
    if (cdata != null) {
      const s = decodeEntities(String(cdata)).trim()
      return s || null
    }
    return null
  }
  const s = decodeEntities(String(node)).trim()
  return s || null
}

export interface FeedChannelMeta {
  /** Channel <title> — the auto-derived show/feed name. */
  title: string | null
  /** <itunes:category text="…"> if present, else a plain <category>. */
  category: string | null
  /** Number of <item> entries in the feed. */
  itemCount: number
}

/**
 * Parse an RSS document's channel-level metadata (title, category, item count).
 * Used to resolve a show key's display name + category from its live archive feed
 * without ingesting any episodes. Returns blanks for a document that isn't a feed.
 */
export function parseChannelMeta(xml: string): FeedChannelMeta {
  const parsed = parser.parse(xml)
  const channel = parsed?.rss?.channel
  if (!channel) return { title: null, category: null, itemCount: 0 }

  const title = rssText(channel.title)

  // The archive carries TWO category signals: a plain channel-level <category>
  // holding the station's own classification (e.g. "Español", "Music" — the exact
  // values the ingest excluded_categories list matches), and an <itunes:category
  // text="…"> with the generic Apple taxonomy ("News & Politics"). Prefer the
  // plain one — it's the station-meaningful value exclusion keys on — and fall
  // back to itunes only when there's no plain <category>. Either may be an array
  // (multiple categories); take the first. itunes carries its label in @_text.
  let category: string | null = null
  const plain = channel.category
  const firstPlain = Array.isArray(plain) ? plain[0] : plain
  if (firstPlain != null) {
    category = rssText((firstPlain as Record<string, unknown>)['@_text']) ?? rssText(firstPlain)
  }
  if (!category) {
    const itunes = channel['itunes:category']
    const firstItunes = Array.isArray(itunes) ? itunes[0] : itunes
    if (firstItunes != null) {
      category = rssText((firstItunes as Record<string, unknown>)['@_text']) ?? rssText(firstItunes)
    }
  }

  // item is forced to an array by the parser config, so length is the count.
  const items = channel.item
  const itemCount = Array.isArray(items) ? items.length : items ? 1 : 0

  return { title, category, itemCount }
}
