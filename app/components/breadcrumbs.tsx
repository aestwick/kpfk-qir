'use client'

import { usePathname } from 'next/navigation'

const ROUTE_LABELS: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/dashboard/episodes': 'Episodes',
  '/dashboard/jobs': 'Jobs',
  '/dashboard/activity': 'Activity',
  '/dashboard/usage': 'Usage',
  '/dashboard/generate': 'Generate QIR',
  '/dashboard/downloads': 'Downloads',
  '/dashboard/settings': 'Settings',
}

export function Breadcrumbs({ episodeName }: { episodeName?: string }) {
  const pathname = usePathname()

  // Build breadcrumb trail
  const parts = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  let accumulated = ''
  for (const part of parts) {
    accumulated += '/' + part
    const label = ROUTE_LABELS[accumulated]
    if (label) {
      crumbs.push({ label, href: accumulated })
    } else if (episodeName && accumulated.match(/\/episodes\/\d+$/)) {
      crumbs.push({ label: episodeName, href: accumulated })
    }
  }

  if (crumbs.length <= 1) return null

  return (
    <nav className="flex items-center gap-1.5 text-xs text-gray-400 mb-4">
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-gray-300">/</span>}
          {i < crumbs.length - 1 ? (
            <a href={crumb.href} className="hover:text-gray-600 transition-colors">{crumb.label}</a>
          ) : (
            <span className="text-gray-600 font-medium">{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}
