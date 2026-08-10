/**
 * Helpers for resolving a show's display name and grouping identity.
 *
 * A single logical show can span multiple feeds (show_keys) and carry alternate
 * name spellings. We keep identity (grouping) strictly separate from the name:
 *
 *   - Grouping/merging uses {@link resolveShowGroup} — never the name, which is
 *     unreliable across feeds/systems.
 *   - The name is purely for display/listing via {@link resolveShowDisplayName}.
 */

/** Fields needed to resolve a show's name and group. A subset of ShowKey. */
export interface ShowNameFields {
  key: string
  show_name?: string | null
  feed_name?: string | null
  display_name?: string | null
  show_group?: string | null
}

function firstNonBlank(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    const t = v?.trim()
    if (t) return t
  }
  return null
}

/**
 * Tidy an auto-derived RSS name against a station's configured strip prefixes.
 * When the name starts with one of the prefixes (e.g. "KPFK -"), drop the prefix
 * and any leading "the" word so the name begins at the first meaningful word
 * (e.g. "KPFK - The Car Show" → "Car Show"). The prefixes are station config
 * (stations.show_name_strip_prefixes), not hard-coded. Names that match no prefix
 * are returned untouched. Applied only to feed_name/show_name — never to a manual
 * display_name override or a hand-entered group label.
 */
export function cleanFeedName(name: string, stripPrefixes?: string[] | null): string {
  const trimmed = name.trim()
  for (const raw of stripPrefixes ?? []) {
    const prefix = raw?.trim()
    if (!prefix) continue
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      // Strip the prefix, then a single leading "the" (word-boundary) plus any
      // trailing punctuation/space, so "KPFK - The Lawyers Guild" → "Lawyers Guild".
      const rest = trimmed.slice(prefix.length).replace(/^[\s,:-]*/, '').replace(/^the\b[\s,:-]*/i, '').trim()
      // Keep the pre-strip remainder if stripping emptied it (e.g. "KPFK - The").
      return rest || trimmed.slice(prefix.length).trim() || trimmed
    }
  }
  return trimmed
}

/**
 * Resolved display name: manual override → RSS-derived feed name → legacy
 * show_name → the key itself as a last resort. The RSS-derived names are tidied
 * via {@link cleanFeedName} using the station's strip prefixes; the manual
 * override is used verbatim. Display only.
 */
export function resolveShowDisplayName(row: ShowNameFields, stripPrefixes?: string[] | null): string {
  const override = row.display_name?.trim()
  if (override) return override
  const auto = firstNonBlank(row.feed_name, row.show_name)
  if (auto) return cleanFeedName(auto, stripPrefixes)
  return row.key
}

/**
 * Effective grouping identity: the explicit show_group when set, otherwise the
 * feed's own key (so ungrouped feeds stay standalone). This is the reliable
 * merge key — independent of name spelling.
 */
export function resolveShowGroup(row: Pick<ShowNameFields, 'key' | 'show_group'>): string {
  return row.show_group?.trim() || row.key
}

/**
 * Normalized merge key for grouping feeds into one logical show. Same identity as
 * {@link resolveShowGroup} but case-insensitive, so manually-typed group labels
 * that differ only by capitalization ("Rhapsody in Black" vs "Rhapsody In Black")
 * still merge. Use this for Map keys / grouping; use {@link resolveShowGroup} or
 * {@link resolveGroupDisplayName} for the human-readable label.
 */
export function showGroupKey(row: Pick<ShowNameFields, 'key' | 'show_group'>): string {
  return resolveShowGroup(row).toLowerCase()
}

/** ISO 639-1 code assumed when a show has no explicit primary language. */
export const DEFAULT_SHOW_LANGUAGE = 'en'

/**
 * A show's effective primary language as an ISO 639-1 code. Soft-defaults to
 * English: staff only record a primary_language for shows that air in another
 * language, so a null/blank value means "English unless specced otherwise".
 * Stored values stay null — the default is applied only at read time.
 */
export function resolveShowLanguage(row: { primary_language?: string | null }): string {
  return row.primary_language?.trim().toLowerCase() || DEFAULT_SHOW_LANGUAGE
}

/**
 * Canonical display name for a logical show made of one or more feeds. Resolution:
 *   1. An explicit display_name override on any feed (a curated override wins).
 *   2. The explicit show_group label, when set — staff type a human-readable name
 *      into Group (e.g. "The Car Show"), so prefer it over arbitrary RSS titles
 *      that vary across sibling feeds ("Car Show, The", "… B Hour 2").
 *   3. Otherwise the first feed's resolved name (feed_name → show_name → key).
 * Returns 'Unknown Show' for an empty group.
 */
export function resolveGroupDisplayName(feeds: ShowNameFields[], stripPrefixes?: string[] | null): string {
  const overridden = feeds.find((f) => f.display_name?.trim())
  if (overridden) return resolveShowDisplayName(overridden, stripPrefixes)
  // An explicit show_group is a human-entered label shared across the feeds; use
  // it as the name — but ONLY when it's a real label, not just the feed's own key
  // copied into show_group. Backfills/imports set show_group = key as the default
  // grouping identity (equivalent to null for grouping; see resolveShowGroup), and
  // that key is not a display name. A key-equal group falls through to the feed's
  // resolved name (feed_name → show_name) so the bare key never surfaces.
  // (Ungrouped feeds have show_group null and fall through here too.)
  const grouped = feeds.find(
    (f) => f.show_group?.trim() && f.show_group.trim().toLowerCase() !== f.key.trim().toLowerCase(),
  )
  if (grouped) return grouped.show_group!.trim()
  return feeds.length ? resolveShowDisplayName(feeds[0], stripPrefixes) : 'Unknown Show'
}
