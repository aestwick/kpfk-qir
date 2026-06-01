'use client'

import { usePathname } from 'next/navigation'

const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/dashboard/episodes': 'Episodes',
  '/dashboard/compliance': 'Compliance',
  '/dashboard/compliance/grid': 'Grid Report',
  '/dashboard/jobs': 'Jobs',
  '/dashboard/activity': 'Activity',
  '/dashboard/usage': 'Usage',
  '/dashboard/shows/audit': 'Show Audit',
  '/dashboard/generate': 'Generate QIR',
  '/dashboard/downloads': 'Downloads',
  '/dashboard/settings': 'Settings',
}

export function Breadcrumbs({
  episodeName,
  origin,
}: {
  episodeName?: string
  /** Overrides the intermediate crumb for pages (like episode detail) that can
   *  be reached from multiple places — so the trail reflects how the user got
   *  here rather than the literal URL path. */
  origin?: { label: string; href: string }
}) {
  const pathname = usePathname()

  // Build breadcrumb trail
  const parts = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  let accumulated = ''
  for (const part of parts) {
    accumulated += '/' + part
    const isEpisodeLeaf = accumulated.match(/\/episodes\/\d+$/)
    // For the episode leaf, swap the preceding "Episodes" crumb for the actual
    // origin (a Show page, Compliance, etc.) when one was provided.
    if (origin && isEpisodeLeaf && crumbs.length > 0) {
      crumbs[crumbs.length - 1] = origin
    }
    const label = ROUTE_LABELS[accumulated]
    if (label) {
      crumbs.push({ label, href: accumulated })
    } else if (episodeName && isEpisodeLeaf) {
      crumbs.push({ label: episodeName, href: accumulated })
    }
  }

  // Drop any crumb that repeats an earlier href (e.g. when the origin override
  // is the Dashboard root, which already leads the trail).
  const deduped = crumbs.filter((c, i) => crumbs.findIndex((o) => o.href === c.href) === i)

  if (deduped.length <= 1) return null

  return (
    <nav className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-warm-500 mb-4">
      {deduped.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300 dark:text-warm-600">/</span>}
          {i < deduped.length - 1 ? (
            <a href={crumb.href} className="hover:text-gray-600 dark:hover:text-warm-300 transition-colors">{crumb.label}</a>
          ) : (
            <span className="text-gray-600 dark:text-warm-300 font-medium">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
