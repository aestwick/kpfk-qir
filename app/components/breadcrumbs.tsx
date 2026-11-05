'use client'

import { usePathname } from 'next/navigation'
import { breadcrumbTrail } from '@/lib/nav'

/**
 * Home › section › page trail. Labels come from the one menu definition in
 * lib/nav.ts, so a renamed page is renamed here too.
 */
export function Breadcrumbs({
  episodeName,
  origin,
}: {
  /** Name of the leaf (an episode's or a show's name). */
  episodeName?: string
  /** Overrides the section crumb for pages (like episode detail) that can
   *  be reached from multiple places — so the trail reflects how the user got
   *  here rather than the literal URL path. */
  origin?: { label: string; href: string }
}) {
  const pathname = usePathname()
  const crumbs = breadcrumbTrail(pathname, { leafLabel: episodeName, origin })

  if (crumbs.length <= 1) return null

  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-gray-400 dark:text-warm-500 mb-4">
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5 min-w-0">
          {i > 0 && <span className="text-gray-300 dark:text-warm-600">/</span>}
          {i < crumbs.length - 1 ? (
            <a href={crumb.href} className="hover:text-gray-600 dark:hover:text-warm-300 transition-colors">{crumb.label}</a>
          ) : (
            <span className="text-gray-600 dark:text-warm-300 font-medium truncate" aria-current="page">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
