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
 * Resolved display name: manual override → RSS-derived feed name → legacy
 * show_name → the key itself as a last resort. Display/listing only.
 */
export function resolveShowDisplayName(row: ShowNameFields): string {
  return firstNonBlank(row.display_name, row.feed_name, row.show_name) ?? row.key
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
 * Canonical display name for a logical show made of one or more feeds. Feeds in
 * a group can carry different name spellings, so we pick a single representative:
 * the first feed's resolved display name (feeds are expected to be passed in a
 * stable order). Returns 'Unknown Show' for an empty group.
 */
export function resolveGroupDisplayName(feeds: ShowNameFields[]): string {
  // Prefer the first feed that has an explicit override, then any feed's resolved
  // name, so a single curated display_name wins for the whole group.
  const overridden = feeds.find((f) => f.display_name?.trim())
  if (overridden) return resolveShowDisplayName(overridden)
  return feeds.length ? resolveShowDisplayName(feeds[0]) : 'Unknown Show'
}
