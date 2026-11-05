'use client'

import { useMemo, useState } from 'react'
import { applyCorrections, correctionsForEpisode, isSelfReapplying } from '@/lib/transcription/corrections'

interface Correction {
  id: number
  wrong: string
  correct: string
  case_sensitive: boolean
  is_regex: boolean
  active: boolean
  notes: string | null
  created_at: string
  episode_id?: number | null
  show_key?: string | null
  backfilled_at?: string | null
}

export interface ShowOption {
  key: string
  label: string
}

export interface CorrectionForm {
  wrong: string
  correct: string
  case_sensitive: boolean
  is_regex: boolean
  notes: string
  show_key: string
}

const EMPTY_FORM: CorrectionForm = { wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '', show_key: '' }

/* ─── Corrections Table + Form + Test Area ─── */
export function TranscriptCorrections({
  corrections,
  shows,
  onSaveCorrection,
  onToggleCorrection,
  onDeleteCorrection,
}: {
  corrections: Correction[]
  shows: ShowOption[]
  onSaveCorrection: (form: CorrectionForm, editingId: number | null) => Promise<void>
  onToggleCorrection: (id: number, active: boolean) => void
  onDeleteCorrection: (id: number) => void
}) {
  const [correctionForm, setCorrectionForm] = useState<CorrectionForm>(EMPTY_FORM)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testShow, setTestShow] = useState('')
  const [testOutput, setTestOutput] = useState('')
  const showLabel = useMemo(() => new Map(shows.map((s) => [s.key, s.label])), [shows])

  function startEdit(c: Correction) {
    setEditingId(c.id)
    setCorrectionForm({
      wrong: c.wrong,
      correct: c.correct,
      case_sensitive: c.case_sensitive,
      is_regex: c.is_regex,
      notes: c.notes ?? '',
      show_key: c.show_key ?? '',
    })
  }

  async function handleSave() {
    if (!correctionForm.wrong || !correctionForm.correct) return
    await onSaveCorrection(correctionForm, editingId)
    setCorrectionForm(EMPTY_FORM)
    setEditingId(null)
  }

  // Same engine and scoping the transcription worker uses (lib/transcription/corrections).
  function testCorrections() {
    const rules = corrections
      .filter((c) => c.active && c.episode_id == null)
      .map((c) => ({ wrong: c.wrong, correct: c.correct, caseSensitive: c.case_sensitive, isRegex: c.is_regex, showKey: c.show_key ?? null }))
    setTestOutput(applyCorrections(testInput, correctionsForEpisode(rules, -1, testShow || null)))
  }

  const scopeLabel = (c: Correction) =>
    c.episode_id != null ? `Episode ${c.episode_id}` : c.show_key ? showLabel.get(c.show_key) ?? c.show_key : 'All shows'

  return (
    <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-4">
      <div>
        <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Transcript Corrections</h3>
        <p className="text-xs text-gray-500 dark:text-warm-400 mt-1">
          Find-and-replace rules for words Whisper gets wrong. A rule fixes new transcripts and is also applied to
          transcripts already stored (text only — no audio is re-transcribed). Limit a name fix to its show when the
          wrong spelling is a real name elsewhere (e.g. &ldquo;Nick Richard&rdquo;).
        </p>
      </div>

      {/* Add/Edit Form */}
      <div className="border dark:border-warm-600 rounded p-3 space-y-3 bg-gray-50 dark:bg-warm-700">
        <p className="text-sm font-medium">{editingId ? 'Edit Correction' : 'Add Correction'}</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="text-xs text-gray-500 dark:text-warm-400">Wrong (what Whisper outputs)</label>
            <input
              type="text"
              value={correctionForm.wrong}
              onChange={(e) => setCorrectionForm({ ...correctionForm, wrong: e.target.value })}
              className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
              placeholder="e.g. Carrie Harrison"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-warm-400">Correct (what it should be)</label>
            <input
              type="text"
              value={correctionForm.correct}
              onChange={(e) => setCorrectionForm({ ...correctionForm, correct: e.target.value })}
              className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
              placeholder="e.g. Cary Harrison"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-warm-400">Applies to</label>
            <select
              value={correctionForm.show_key}
              onChange={(e) => setCorrectionForm({ ...correctionForm, show_key: e.target.value })}
              className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100"
            >
              <option value="">All shows</option>
              {shows.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500">Notes (optional)</label>
          <input
            type="text"
            value={correctionForm.notes}
            onChange={(e) => setCorrectionForm({ ...correctionForm, notes: e.target.value })}
            className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
            placeholder="e.g. host of the Friday show"
          />
        </div>
        <div className="flex flex-wrap gap-4 items-center">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={correctionForm.case_sensitive}
              onChange={(e) => setCorrectionForm({ ...correctionForm, case_sensitive: e.target.checked })}
            />
            Case sensitive
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={correctionForm.is_regex}
              onChange={(e) => setCorrectionForm({ ...correctionForm, is_regex: e.target.checked })}
            />
            Regex
          </label>
          <div className="flex-1" />
          {editingId && (
            <button
              onClick={() => { setEditingId(null); setCorrectionForm(EMPTY_FORM) }}
              className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 dark:text-warm-400 dark:hover:text-warm-200"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            className="px-4 py-1.5 text-sm bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700 dark:hover:bg-green-600"
          >
            {editingId ? 'Update' : 'Add'}
          </button>
        </div>
      </div>

      {/* Corrections Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-warm-700 border-b dark:border-warm-600">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Wrong</th>
              <th className="text-left px-3 py-2 font-medium">Correct</th>
              <th className="text-left px-3 py-2 font-medium">Applies to</th>
              <th className="text-left px-3 py-2 font-medium">Flags</th>
              <th className="text-left px-3 py-2 font-medium">Past transcripts</th>
              <th className="text-left px-3 py-2 font-medium">Notes</th>
              <th className="text-left px-3 py-2 font-medium">Active</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-warm-700">
            {corrections.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500 dark:text-warm-400">No corrections yet</td></tr>
            ) : corrections.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                <td className="px-3 py-2 font-mono">{c.wrong}</td>
                <td className="px-3 py-2 font-mono">{c.correct}</td>
                <td className="px-3 py-2 text-gray-600 dark:text-warm-300">{scopeLabel(c)}</td>
                <td className="px-3 py-2">
                  {c.case_sensitive && <span className="text-xs bg-gray-100 dark:bg-warm-700 px-1 rounded mr-1">CS</span>}
                  {c.is_regex && <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1 rounded">Regex</span>}
                </td>
                <td className="px-3 py-2 text-xs">
                  {!c.active ? (
                    <span className="text-gray-400 dark:text-warm-500">—</span>
                  ) : isSelfReapplying({ wrong: c.wrong, correct: c.correct, caseSensitive: c.case_sensitive, isRegex: c.is_regex }) ? (
                    <span className="text-gray-500 dark:text-warm-400" title="The replacement would be changed again on a second run (e.g. Cary → Cary Harrison), so this rule only fixes NEW transcripts">New only</span>
                  ) : c.backfilled_at ? (
                    <span className="text-green-700 dark:text-green-300" title={`Applied ${new Date(c.backfilled_at).toLocaleString()}`}>Fixed</span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-300" title="Queued: will be applied to stored transcripts within minutes">Queued</span>
                  )}
                </td>
                <td className="px-3 py-2 text-gray-500 dark:text-warm-400 max-w-[200px] truncate">{c.notes ?? ''}</td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => onToggleCorrection(c.id, c.active)}
                    className={`text-xs px-2 py-0.5 rounded ${c.active ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : 'bg-gray-100 text-gray-500 dark:bg-warm-700 dark:text-warm-400'}`}
                  >
                    {c.active ? 'On' : 'Off'}
                  </button>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button onClick={() => startEdit(c)} className="text-xs text-blue-600 dark:text-blue-400 hover:underline mr-2">Edit</button>
                  <button onClick={() => onDeleteCorrection(c.id)} className="text-xs text-red-600 dark:text-red-400 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Test Area */}
      <div className="border dark:border-warm-600 rounded p-3 space-y-2 bg-gray-50 dark:bg-warm-700">
        <p className="text-sm font-medium">Test Corrections</p>
        <textarea
          value={testInput}
          onChange={(e) => setTestInput(e.target.value)}
          placeholder="Paste sample text here to test corrections..."
          rows={3}
          className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={testShow}
            onChange={(e) => setTestShow(e.target.value)}
            className="border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100"
            title="Show-specific rules only apply when testing as that show"
          >
            <option value="">Test as: any show</option>
            {shows.map((s) => (
              <option key={s.key} value={s.key}>Test as: {s.label}</option>
            ))}
          </select>
          <button
            onClick={testCorrections}
            className="px-3 py-1.5 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600"
          >
            Test
          </button>
        </div>
        {testOutput && (
          <div className="bg-white dark:bg-warm-800 border dark:border-warm-600 rounded p-2 text-sm whitespace-pre-wrap">{testOutput}</div>
        )}
      </div>
    </div>
  )
}
