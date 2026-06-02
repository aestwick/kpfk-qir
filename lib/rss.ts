import { XMLParser } from 'fast-xml-parser'

// Single parser config shared across RSS consumers (ingest + archive lookup), so
// CDATA handling and the item-is-always-an-array rule stay identical everywhere.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '__cdata',
  isArray: (name) => name === 'item',
})

/**
 * Unwrap a possibly-CDATA-wrapped RSS text node to a trimmed string (or null).
 * RSS titles/categories arrive either as a plain string or, when CDATA-wrapped,
 * as an object carrying `__cdata` (see the parser config above).
 */
export function rssText(node: unknown): string | null {
  if (node == null) return null
  if (typeof node === 'object') {
    const cdata = (node as { __cdata?: unknown }).__cdata
    if (cdata != null) {
      const s = String(cdata).trim()
      return s || null
    }
    return null
  }
  const s = String(node).trim()
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
