/**
 * Navigation helpers for context-aware back/breadcrumb behavior.
 *
 * The episode detail page can be reached from several places (Episodes list,
 * a Show page, the Show Audit, the Compliance page). We thread the originating
 * location through a `from` query param so the detail page's back link and
 * breadcrumb return the user to where they actually came from — instead of
 * always dumping them on the Episodes list.
 */

export interface NavOrigin {
  label: string
  href: string
}

/** Default origin when we have no `from` hint (or it's unrecognized). */
const DEFAULT_ORIGIN: NavOrigin = { label: 'Episodes', href: '/dashboard/episodes' }

/** Path-prefix → label for known episode origins. Order matters: more
 *  specific prefixes (e.g. /compliance/grid) must come before broader ones,
 *  and the bare /dashboard catch-all must come last. */
const ORIGIN_LABELS: { prefix: string; label: string }[] = [
  { prefix: '/dashboard/shows/audit', label: 'Show Audit' },
  { prefix: '/dashboard/compliance/grid', label: 'Grid Report' },
  { prefix: '/dashboard/compliance', label: 'Compliance' },
  { prefix: '/dashboard/episodes', label: 'Episodes' },
  { prefix: '/dashboard/activity', label: 'Activity' },
  { prefix: '/dashboard/search', label: 'Search' },
  { prefix: '/dashboard/usage', label: 'Usage' },
  { prefix: '/dashboard/generate', label: 'Generate QIR' },
  { prefix: '/dashboard/downloads', label: 'Downloads' },
  { prefix: '/dashboard/settings', label: 'Settings' },
  { prefix: '/dashboard/jobs', label: 'Jobs' },
  { prefix: '/dashboard', label: 'Dashboard' },
]

/** Current location (path + query) suitable for use as a `from` value. */
export function locationFrom(pathname: string, search?: string | null): string {
  return search ? `${pathname}?${search}` : pathname
}

/** Append a `from` hint to an episode-detail href, preserving any existing query. */
export function withFrom(href: string, from?: string | null): string {
  if (!from) return href
  const sep = href.includes('?') ? '&' : '?'
  return `${href}${sep}from=${encodeURIComponent(from)}`
}

/** Build an episode-detail href that remembers where the user came from. */
export function episodeHref(id: number | string, from?: string | null): string {
  return withFrom(`/dashboard/episodes/${id}`, from)
}

/**
 * Resolve a `from` value (path + optional query) into the `{ label, href }`
 * the back link / breadcrumb should point at. For a Show page the label is the
 * show's display name when known, since show keys aren't human-friendly.
 */
export function resolveOrigin(
  from: string | null | undefined,
  show?: { name?: string | null; key?: string | null },
): NavOrigin {
  if (!from) return DEFAULT_ORIGIN
  const path = from.split('?')[0]

  // A specific show page (/dashboard/shows/<key>) — but not the audit view.
  if (path.startsWith('/dashboard/shows/') && !path.startsWith('/dashboard/shows/audit')) {
    return { label: show?.name || show?.key || 'Show', href: from }
  }

  for (const { prefix, label } of ORIGIN_LABELS) {
    if (path.startsWith(prefix)) return { label, href: from }
  }

  return DEFAULT_ORIGIN
}
