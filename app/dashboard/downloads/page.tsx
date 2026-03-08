'use client'

import { useState } from 'react'

function getQuarterOptions() {
  const options: { label: string; year: number; quarter: number }[] = []
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentQ = Math.floor(now.getMonth() / 3) + 1

  for (let y = currentYear; y >= currentYear - 1; y--) {
    const maxQ = y === currentYear ? currentQ : 4
    for (let q = maxQ; q >= 1; q--) {
      options.push({ label: `Q${q} ${y}`, year: y, quarter: q })
    }
  }
  return options
}

export default function DownloadsPage() {
  const quarterOptions = getQuarterOptions()
  const [selected, setSelected] = useState(quarterOptions[0])

  const downloads = [
    {
      label: 'Transcripts',
      description: 'All transcripts for the selected quarter as a combined text file',
      type: 'transcripts',
    },
    {
      label: 'VTT Captions',
      description: 'All VTT caption files for the selected quarter',
      type: 'vtts',
    },
    {
      label: 'Episode Data (CSV)',
      description: 'Full episode metadata for the selected quarter',
      type: 'episodes',
    },
  ]

  const qirExports = [
    {
      label: 'QIR Report (CSV)',
      description: 'Curated QIR entries in spreadsheet format',
      format: 'csv',
    },
    {
      label: 'QIR Report (Text)',
      description: 'Formatted QIR report as plain text',
      format: 'text',
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Downloads</h2>
        <select
          value={`${selected.year}-${selected.quarter}`}
          onChange={(e) => {
            const [y, q] = e.target.value.split('-').map(Number)
            const opt = quarterOptions.find(
              (o) => o.year === y && o.quarter === q
            )
            if (opt) setSelected(opt)
          }}
          className="border rounded px-3 py-2 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
        >
          {quarterOptions.map((o) => (
            <option key={`${o.year}-${o.quarter}`} value={`${o.year}-${o.quarter}`}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {/* Batch Downloads */}
      <div className="bg-white rounded-lg shadow dark:bg-surface-raised dark:shadow-card-dark">
        <div className="px-4 py-3 border-b dark:border-warm-700">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-warm-400 uppercase">
            Batch Downloads — {selected.label}
          </h3>
        </div>
        <div className="divide-y dark:divide-warm-700">
          {downloads.map((dl) => (
            <div
              key={dl.type}
              className="flex items-center justify-between px-4 py-4"
            >
              <div>
                <p className="text-sm font-medium">{dl.label}</p>
                <p className="text-xs text-gray-500 dark:text-warm-400">{dl.description}</p>
              </div>
              <a
                href={`/api/downloads?year=${selected.year}&quarter=${selected.quarter}&type=${dl.type}`}
                className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                Download
              </a>
            </div>
          ))}
        </div>
      </div>

      {/* QIR Exports */}
      <div className="bg-white rounded-lg shadow dark:bg-surface-raised dark:shadow-card-dark">
        <div className="px-4 py-3 border-b dark:border-warm-700">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-warm-400 uppercase">
            QIR Report Exports
          </h3>
          <p className="text-xs text-gray-400 dark:text-warm-500 mt-1">
            To export a specific QIR draft, go to the Generate QIR page and use
            the export buttons there.
          </p>
        </div>
        <div className="divide-y dark:divide-warm-700">
          {qirExports.map((exp) => (
            <div
              key={exp.format}
              className="flex items-center justify-between px-4 py-4"
            >
              <div>
                <p className="text-sm font-medium">{exp.label}</p>
                <p className="text-xs text-gray-500 dark:text-warm-400">{exp.description}</p>
              </div>
              <a
                href={`/dashboard/generate`}
                className="px-4 py-2 border text-sm rounded hover:bg-gray-50 dark:border-warm-600 dark:hover:bg-warm-700/50 dark:text-warm-200"
              >
                Go to QIR Builder
              </a>
            </div>
          ))}
        </div>
      </div>

      {/* Public QIR Link */}
      <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
        <h3 className="text-sm font-semibold text-gray-500 dark:text-warm-400 uppercase mb-2">
          Public QIR Page
        </h3>
        <p className="text-sm text-gray-600 dark:text-warm-400 mb-2">
          Finalized QIR reports are published at:
        </p>
        <a
          href={`/${selected.year}/q${selected.quarter}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          /{selected.year}/q{selected.quarter}
        </a>
      </div>
    </div>
  )
}
