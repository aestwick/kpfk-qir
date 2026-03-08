'use client'

interface QirEntry {
  episode_id: number
  show_name: string
  host: string
  air_date: string
  start_time: string
  duration: number
  headline: string
  guest: string
  summary: string
  issue_category: string
}

/* ─── Full Report Text View ─── */
export function FullReportView({ text }: { text: string | null }) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <pre className="whitespace-pre-wrap text-sm font-mono text-gray-800 max-h-[600px] overflow-y-auto">
        {text ?? 'No full report available'}
      </pre>
    </div>
  )
}

/* ─── Curated Entries by Category ─── */
export function CuratedEntriesView({
  groupedEntries,
  isDraft,
  editingEntry,
  editSummary,
  onSetEditingEntry,
  onSetEditSummary,
  onSaveEdit,
  onRemoveEntry,
}: {
  groupedEntries: Record<string, QirEntry[]>
  isDraft: boolean
  editingEntry: number | null
  editSummary: string
  onSetEditingEntry: (id: number | null) => void
  onSetEditSummary: (s: string) => void
  onSaveEdit: (episodeId: number) => void
  onRemoveEntry: (episodeId: number) => void
}) {
  return (
    <div className="space-y-6">
      {Object.entries(groupedEntries).map(([category, entries]) => (
        <div key={category} className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b bg-gray-50">
            <h4 className="text-sm font-semibold uppercase text-gray-600">
              {category}
              <span className="ml-2 text-gray-400 font-normal">
                ({entries.length} entries)
              </span>
            </h4>
          </div>
          <div className="divide-y">
            {entries.map((entry) => (
              <div key={entry.episode_id} className="px-4 py-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {entry.show_name}
                      {entry.host && (
                        <span className="text-gray-500 font-normal">
                          {' '}
                          — {entry.host}
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      {entry.air_date} | {entry.start_time} |{' '}
                      {entry.duration} min
                      {entry.guest && ` | Guest: ${entry.guest}`}
                    </p>
                    <p className="text-sm font-medium mt-1">
                      {entry.headline}
                    </p>
                    {editingEntry === entry.episode_id ? (
                      <div className="mt-1">
                        <textarea
                          value={editSummary}
                          onChange={(e) => onSetEditSummary(e.target.value)}
                          className="w-full border rounded p-2 text-sm"
                          rows={4}
                        />
                        <div className="flex gap-2 mt-1">
                          <button
                            onClick={() => onSaveEdit(entry.episode_id)}
                            className="text-xs px-2 py-1 bg-blue-600 text-white rounded"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => onSetEditingEntry(null)}
                            className="text-xs px-2 py-1 border rounded"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-gray-700 mt-1">
                        {entry.summary}
                      </p>
                    )}
                  </div>
                  {isDraft && (
                    <div className="flex gap-1 ml-3 shrink-0">
                      <button
                        onClick={() => {
                          onSetEditingEntry(entry.episode_id)
                          onSetEditSummary(entry.summary)
                        }}
                        className="text-xs px-2 py-1 text-blue-600 hover:bg-blue-50 rounded"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onRemoveEntry(entry.episode_id)}
                        className="text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
