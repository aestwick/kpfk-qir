'use client'

import Link from 'next/link'

/**
 * Standardized "← Label" back link. Uses next/link so navigation stays
 * client-side (no full-page reload / dashboard layout remount).
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-sm text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-200"
    >
      &larr; {label}
    </Link>
  )
}
