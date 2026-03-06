'use client'

export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800"
    >
      Print / Save PDF
    </button>
  )
}
