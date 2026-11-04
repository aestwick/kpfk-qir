'use client'

import { useEffect, useState } from 'react'
import { getQuarterOptions } from '@/lib/quarters'
import { downloadWithAuth, getActiveStationSlug } from '@/lib/api-client'
import { publicQirPath } from '@/lib/download'

export default function DownloadsPage() {
  // Reach back far enough to export historical-backfill quarters (e.g. WPFW's
  // one-off Q4 2020), not just the last year. The downloads API is quarter-agnostic.
  const quarterOptions = getQuarterOptions(6)
  const [selected, setSelected] = useState(quarterOptions[0])
  const [busyType, setBusyType] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Read after mount (document.cookie isn't available during prerender). The
  // station switcher reloads the page on change, so this stays current.
  const [stationSlug, setStationSlug] = useState<string | null>(null)
  useEffect(() => setStationSlug(getActiveStationSlug()), [])

  // /api/downloads needs the Bearer token, which a plain <a href> can't send.
  async function handleDownload(type: string) {
    setBusyType(type)
    setError(null)
    try {
      const params = new URLSearchParams({
        year: String(selected.year),
        quarter: String(selected.quarter),
        type,
      })
      const ext = type === 'episodes' ? 'csv' : 'txt'
      await downloadWithAuth(
        `/api/downloads?${params}`,
        `${type}_Q${selected.quarter}_${selected.year}.${ext}`
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Download failed')
    } finally {
      setBusyType(null)
    }
  }

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
              <button
                type="button"
                onClick={() => handleDownload(dl.type)}
                disabled={busyType !== null}
                className="px-4 py-2 bg-gray-900 text-white text-sm rounded hover:bg-gray-800 disabled:opacity-50 disabled:cursor-wait dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                {busyType === dl.type ? 'Preparing…' : 'Download'}
              </button>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="px-4 py-3 border-t text-sm text-red-600 dark:border-warm-700 dark:text-red-400">
            {error}
          </p>
        )}
      </div>

      {/* QIR Exports */}
      <div className="bg-white rounded-lg shadow dark:bg-surface-raised dark:shadow-card-dark">
        <div className="px-4 py-3 border-b dark:border-warm-700">
          <h3 className="text-sm font-semibold text-gray-500 dark:text-warm-400 uppercase">
            QIR Report Exports
          </h3>
          <p className="text-xs text-gray-400 dark:text-warm-500 mt-1">
            To export a specific QIR draft, go to the Quarterly report page and use
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
                Go to Quarterly report
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
        {stationSlug ? (
          <a
            href={publicQirPath(stationSlug, selected.year, selected.quarter)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
          >
            {publicQirPath(stationSlug, selected.year, selected.quarter)}
          </a>
        ) : (
          <p className="text-sm text-gray-400 dark:text-warm-500">
            Select a station to see its public report link.
          </p>
        )}
      </div>
    </div>
  )
}
