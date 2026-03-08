'use client'

import { useState } from 'react'

interface Correction {
  id: number
  wrong: string
  correct: string
  case_sensitive: boolean
  is_regex: boolean
  active: boolean
  notes: string | null
  created_at: string
}

/* ─── Corrections Table + Form + Test Area ─── */
export function TranscriptCorrections({
  corrections,
  onSaveCorrection,
  onToggleCorrection,
  onDeleteCorrection,
}: {
  corrections: Correction[]
  onSaveCorrection: (form: { wrong: string; correct: string; case_sensitive: boolean; is_regex: boolean; notes: string }, editingId: number | null) => Promise<void>
  onToggleCorrection: (id: number, active: boolean) => void
  onDeleteCorrection: (id: number) => void
}) {
  const [correctionForm, setCorrectionForm] = useState({ wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')

  function startEdit(c: Correction) {
    setEditingId(c.id)
    setCorrectionForm({
      wrong: c.wrong,
      correct: c.correct,
      case_sensitive: c.case_sensitive,
      is_regex: c.is_regex,
      notes: c.notes ?? '',
    })
  }

  async function handleSave() {
    if (!correctionForm.wrong || !correctionForm.correct) return
    await onSaveCorrection(correctionForm, editingId)
    setCorrectionForm({ wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '' })
    setEditingId(null)
  }

  function testCorrections() {
    let output = testInput
    for (const c of corrections.filter((x) => x.active)) {
      try {
        if (c.is_regex) {
          const flags = c.case_sensitive ? 'g' : 'gi'
          output = output.replace(new RegExp(c.wrong, flags), c.correct)
        } else if (c.case_sensitive) {
          output = output.split(c.wrong).join(c.correct)
        } else {
          output = output.replace(new RegExp(c.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), c.correct)
        }
      } catch {
        // skip invalid regex
      }
    }
    setTestOutput(output)
  }

  return (
    <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-4">
      <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Transcript Corrections</h3>

      {/* Add/Edit Form */}
      <div className="border dark:border-warm-600 rounded p-3 space-y-3 bg-gray-50 dark:bg-warm-700">
        <p className="text-sm font-medium">{editingId ? 'Edit Correction' : 'Add Correction'}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-500 dark:text-warm-400">Wrong (what Whisper outputs)</label>
            <input
              type="text"
              value={correctionForm.wrong}
              onChange={(e) => setCorrectionForm({ ...correctionForm, wrong: e.target.value })}
              className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
              placeholder="e.g. Kay PFK"
            />
          </div>
          <div>
            <label className="text-xs text-gray-500 dark:text-warm-400">Correct (what it should be)</label>
            <input
              type="text"
              value={correctionForm.correct}
              onChange={(e) => setCorrectionForm({ ...correctionForm, correct: e.target.value })}
              className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
              placeholder="e.g. KPFK"
            />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-500">Notes (optional)</label>
          <input
            type="text"
            value={correctionForm.notes}
            onChange={(e) => setCorrectionForm({ ...correctionForm, notes: e.target.value })}
            className="w-full border dark:border-warm-600 rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
            placeholder="e.g. station call letters"
          />
        </div>
        <div className="flex gap-4 items-center">
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
              onClick={() => { setEditingId(null); setCorrectionForm({ wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '' }) }}
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
              <th className="text-left px-3 py-2 font-medium">Flags</th>
              <th className="text-left px-3 py-2 font-medium">Notes</th>
              <th className="text-left px-3 py-2 font-medium">Active</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y dark:divide-warm-700">
            {corrections.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500 dark:text-warm-400">No corrections yet</td></tr>
            ) : corrections.map((c) => (
              <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                <td className="px-3 py-2 font-mono">{c.wrong}</td>
                <td className="px-3 py-2 font-mono">{c.correct}</td>
                <td className="px-3 py-2">
                  {c.case_sensitive && <span className="text-xs bg-gray-100 dark:bg-warm-700 px-1 rounded mr-1">CS</span>}
                  {c.is_regex && <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 px-1 rounded">Regex</span>}
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
                <td className="px-3 py-2 text-right">
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
        <button
          onClick={testCorrections}
          className="px-3 py-1.5 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600"
        >
          Test
        </button>
        {testOutput && (
          <div className="bg-white dark:bg-warm-800 border dark:border-warm-600 rounded p-2 text-sm whitespace-pre-wrap">{testOutput}</div>
        )}
      </div>
    </div>
  )
}
