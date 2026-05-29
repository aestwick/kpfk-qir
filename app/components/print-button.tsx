'use client'

export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="px-4 py-2 bg-gray-900 text-white dark:bg-warm-200 dark:text-warm-900 text-sm rounded hover:bg-gray-800 dark:hover:bg-warm-100"
    >
      Print / Save PDF
    </button>
  )
}
