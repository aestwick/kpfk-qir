'use client'

export function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg shadow p-4 animate-pulse">
      <div className="h-3 bg-gray-200 rounded w-1/3 mb-3" />
      <div className="h-6 bg-gray-200 rounded w-1/2" />
    </div>
  )
}

export function SkeletonRow() {
  return (
    <tr className="animate-pulse">
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-32" /></td>
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-20" /></td>
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-12" /></td>
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded-full w-16" /></td>
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-40" /></td>
      <td className="px-4 py-3"><div className="h-4 bg-gray-200 rounded w-24" /></td>
    </tr>
  )
}

export function SkeletonTableRows({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </>
  )
}

export function SkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  )
}

export function SkeletonBlock() {
  return (
    <div className="bg-white rounded-lg shadow p-4 animate-pulse space-y-3">
      <div className="h-3 bg-gray-200 rounded w-1/4" />
      <div className="h-4 bg-gray-200 rounded w-full" />
      <div className="h-4 bg-gray-200 rounded w-3/4" />
      <div className="h-4 bg-gray-200 rounded w-1/2" />
    </div>
  )
}
