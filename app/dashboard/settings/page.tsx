'use client'

import { useEffect, useState, useCallback } from 'react'
import { SkeletonBlock } from '@/app/components/skeleton'

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

interface SettingField {
  key: string
  label: string
  type: 'text' | 'number' | 'json' | 'textarea'
}

const settingFields: SettingField[] = [
  { key: 'station_id', label: 'Station ID', type: 'text' },
  { key: 'max_entries_per_category', label: 'Max Entries Per Category', type: 'number' },
  { key: 'issue_categories', label: 'Issue Categories (JSON array)', type: 'json' },
  { key: 'excluded_categories', label: 'Excluded Categories (JSON array)', type: 'json' },
  { key: 'summarization_model', label: 'Summarization Model', type: 'text' },
  { key: 'transcription_model', label: 'Transcription Model', type: 'text' },
  { key: 'transcribe_batch_size', label: 'Transcribe Batch Size', type: 'number' },
  { key: 'summarize_batch_size', label: 'Summarize Batch Size', type: 'number' },
  { key: 'summarization_prompt', label: 'Summarization Prompt', type: 'textarea' },
  { key: 'curation_prompt', label: 'Curation Prompt', type: 'textarea' },
]

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [loading, setLoading] = useState(true)
  const [correctionForm, setCorrectionForm] = useState({ wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState('')

  const fetchAll = useCallback(async () => {
    const [settingsRes, correctionsRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/corrections'),
    ])
    if (settingsRes.ok) {
      const data = await settingsRes.json()
      setSettings(data.settings ?? {})
      const vals: Record<string, string> = {}
      for (const field of settingFields) {
        const v = data.settings?.[field.key]
        if (field.type === 'json') {
          vals[field.key] = typeof v === 'string' ? v : JSON.stringify(v, null, 2)
        } else {
          vals[field.key] = v != null ? String(v) : ''
        }
      }
      setEditValues(vals)
    }
    if (correctionsRes.ok) {
      const data = await correctionsRes.json()
      setCorrections(data.corrections ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  async function saveSetting(key: string) {
    setSaving(key)
    const field = settingFields.find((f) => f.key === key)
    let value: unknown = editValues[key]
    if (field?.type === 'number') value = Number(value)
    else if (field?.type === 'json') {
      try { value = JSON.parse(value as string) } catch { setSaving(null); return }
    }
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    })
    setSaving(null)
  }

  async function saveCorrection() {
    if (!correctionForm.wrong || !correctionForm.correct) return

    if (editingId) {
      await fetch('/api/corrections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId, ...correctionForm }),
      })
    } else {
      await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(correctionForm),
      })
    }

    setCorrectionForm({ wrong: '', correct: '', case_sensitive: false, is_regex: false, notes: '' })
    setEditingId(null)
    fetchAll()
  }

  async function toggleCorrection(id: number, active: boolean) {
    await fetch('/api/corrections', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: !active }),
    })
    fetchAll()
  }

  async function deleteCorrection(id: number) {
    if (!confirm('Delete this correction?')) return
    await fetch(`/api/corrections?id=${id}`, { method: 'DELETE' })
    fetchAll()
  }

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

  if (loading) return (
    <div className="space-y-8">
      <h2 className="text-2xl font-bold">Settings</h2>
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )

  return (
    <div className="space-y-8">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* QIR Settings */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">QIR Settings</h3>
        {settingFields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{field.label}</label>
            <div className="flex gap-2">
              {field.type === 'textarea' ? (
                <textarea
                  value={editValues[field.key] ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                  rows={4}
                  className="flex-1 border rounded px-2 py-1.5 text-sm font-mono"
                />
              ) : field.type === 'json' ? (
                <textarea
                  value={editValues[field.key] ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                  rows={3}
                  className="flex-1 border rounded px-2 py-1.5 text-sm font-mono"
                />
              ) : (
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={editValues[field.key] ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                  className="flex-1 border rounded px-2 py-1.5 text-sm"
                />
              )}
              <button
                onClick={() => saveSetting(field.key)}
                disabled={saving === field.key}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 shrink-0"
              >
                {saving === field.key ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Transcript Corrections */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">Transcript Corrections</h3>

        {/* Add/Edit Form */}
        <div className="border rounded p-3 space-y-3 bg-gray-50">
          <p className="text-sm font-medium">{editingId ? 'Edit Correction' : 'Add Correction'}</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-gray-500">Wrong (what Whisper outputs)</label>
              <input
                type="text"
                value={correctionForm.wrong}
                onChange={(e) => setCorrectionForm({ ...correctionForm, wrong: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
                placeholder="e.g. Kay PFK"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">Correct (what it should be)</label>
              <input
                type="text"
                value={correctionForm.correct}
                onChange={(e) => setCorrectionForm({ ...correctionForm, correct: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
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
              className="w-full border rounded px-2 py-1.5 text-sm"
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
                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
            )}
            <button
              onClick={saveCorrection}
              className="px-4 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700"
            >
              {editingId ? 'Update' : 'Add'}
            </button>
          </div>
        </div>

        {/* Corrections Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Wrong</th>
                <th className="text-left px-3 py-2 font-medium">Correct</th>
                <th className="text-left px-3 py-2 font-medium">Flags</th>
                <th className="text-left px-3 py-2 font-medium">Notes</th>
                <th className="text-left px-3 py-2 font-medium">Active</th>
                <th className="text-right px-3 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {corrections.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No corrections yet</td></tr>
              ) : corrections.map((c) => (
                <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                  <td className="px-3 py-2 font-mono">{c.wrong}</td>
                  <td className="px-3 py-2 font-mono">{c.correct}</td>
                  <td className="px-3 py-2">
                    {c.case_sensitive && <span className="text-xs bg-gray-100 px-1 rounded mr-1">CS</span>}
                    {c.is_regex && <span className="text-xs bg-purple-100 text-purple-700 px-1 rounded">Regex</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 max-w-[200px] truncate">{c.notes ?? ''}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => toggleCorrection(c.id, c.active)}
                      className={`text-xs px-2 py-0.5 rounded ${c.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                    >
                      {c.active ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => startEdit(c)} className="text-xs text-blue-600 hover:underline mr-2">Edit</button>
                    <button onClick={() => deleteCorrection(c.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Test Area */}
        <div className="border rounded p-3 space-y-2 bg-gray-50">
          <p className="text-sm font-medium">Test Corrections</p>
          <textarea
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Paste sample text here to test corrections..."
            rows={3}
            className="w-full border rounded px-2 py-1.5 text-sm"
          />
          <button
            onClick={testCorrections}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Test
          </button>
          {testOutput && (
            <div className="bg-white border rounded p-2 text-sm whitespace-pre-wrap">{testOutput}</div>
          )}
        </div>
      </div>
    </div>
  )
}
