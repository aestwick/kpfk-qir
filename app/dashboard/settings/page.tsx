'use client'

import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

/* ─── lazy-loaded corrections component ─── */
const TranscriptCorrections = dynamic(() => import('@/app/components/transcript-corrections').then(m => ({ default: m.TranscriptCorrections })), {
  loading: () => <div className="bg-white rounded-lg shadow p-4"><div className="h-48 bg-gray-100 rounded animate-pulse" /></div>,
  ssr: false,
})

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

interface ComplianceWord {
  id: number
  word: string
  severity: string
  active: boolean
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

const PIPELINE_MODES = [
  {
    key: 'steady',
    label: 'Steady',
    description: 'Normal processing \u2014 1 transcription, 5 summarizations at a time',
    transcribe: 1,
    summarize: 5,
  },
  {
    key: 'catch-up',
    label: 'Catch-up',
    description: 'Faster processing \u2014 3 transcriptions, 10 summarizations at a time',
    transcribe: 3,
    summarize: 10,
  },
] as const

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [pipelineMode, setPipelineMode] = useState('steady')
  const [savingMode, setSavingMode] = useState(false)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [wordlist, setWordlist] = useState<ComplianceWord[]>([])
  const [newWord, setNewWord] = useState('')
  const [newWordSeverity, setNewWordSeverity] = useState<'critical' | 'warning'>('critical')
  const [complianceChecks, setComplianceChecks] = useState<Record<string, boolean>>({})
  const [compliancePrompt, setCompliancePrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; type: 'word' | 'correction' } | null>(null)

  const fetchAll = useCallback(async () => {
    const [settingsRes, correctionsRes, wordlistRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/corrections'),
      fetch('/api/compliance/wordlist'),
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
      if (data.settings?.pipeline_mode) {
        setPipelineMode(data.settings.pipeline_mode as string)
      }
      if (data.settings?.compliance_checks_enabled) {
        setComplianceChecks(data.settings.compliance_checks_enabled as Record<string, boolean>)
      }
      if (data.settings?.compliance_prompt) {
        setCompliancePrompt(data.settings.compliance_prompt as string)
      }
    }
    if (correctionsRes.ok) {
      const data = await correctionsRes.json()
      setCorrections(data.corrections ?? [])
    }
    if (wordlistRes.ok) {
      const data = await wordlistRes.json()
      setWordlist(data.words ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const { toast } = useToast()

  async function saveSetting(key: string) {
    setSaving(key)
    const field = settingFields.find((f) => f.key === key)
    let value: unknown = editValues[key]
    if (field?.type === 'number') value = Number(value)
    else if (field?.type === 'json') {
      try { value = JSON.parse(value as string) } catch { setSaving(null); toast('error', `Invalid JSON for ${key}`); return }
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? `Failed to save ${key}`)
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setSaving(null)
  }

  async function savePipelineMode(mode: string) {
    setSavingMode(true)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'pipeline_mode', value: mode }),
      })
      if (res.ok) {
        setPipelineMode(mode)
        const preset = PIPELINE_MODES.find((m) => m.key === mode)
        toast('success', `Switched to ${preset?.label} mode \u2014 workers will pick this up within 30 seconds`)
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to save pipeline mode')
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setSavingMode(false)
  }

  async function handleSaveCorrection(
    form: { wrong: string; correct: string; case_sensitive: boolean; is_regex: boolean; notes: string },
    editingId: number | null
  ) {
    try {
      const res = editingId
        ? await fetch('/api/corrections', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editingId, ...form }) })
        : await fetch('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!res.ok) { toast('error', 'Failed to save correction'); return }
    } catch { toast('error', 'Network error'); return }
    fetchAll()
  }

  async function handleToggleCorrection(id: number, active: boolean) {
    try {
      await fetch('/api/corrections', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, active: !active }) })
    } catch { toast('error', 'Network error'); return }
    fetchAll()
  }

  async function handleDeleteCorrection(id: number) {
    setDeleteConfirm({ id, type: 'correction' })
  }

  async function executeDelete() {
    if (!deleteConfirm) return
    if (deleteConfirm.type === 'correction') {
      await fetch(`/api/corrections?id=${deleteConfirm.id}`, { method: 'DELETE' })
    } else {
      await fetch(`/api/compliance/wordlist?id=${deleteConfirm.id}`, { method: 'DELETE' })
    }
    setDeleteConfirm(null)
    fetchAll()
  }

  // Compliance wordlist handlers
  async function addWord() {
    if (!newWord.trim()) return
    await fetch('/api/compliance/wordlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: newWord.trim(), severity: newWordSeverity }),
    })
    setNewWord('')
    fetchAll()
  }

  async function toggleWord(id: number, active: boolean) {
    await fetch('/api/compliance/wordlist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: !active }),
    })
    fetchAll()
  }

  async function toggleComplianceCheck(checkType: string) {
    const updated = { ...complianceChecks, [checkType]: !complianceChecks[checkType] }
    setComplianceChecks(updated)
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'compliance_checks_enabled', value: updated }),
    })
  }

  async function saveCompliancePrompt() {
    setSaving('compliance_prompt')
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'compliance_prompt', value: compliancePrompt }),
    })
    setSaving(null)
    toast('success', 'Compliance prompt saved')
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

      {/* Pipeline Processing Mode */}
      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">Processing Mode</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PIPELINE_MODES.map((mode) => {
            const isActive = pipelineMode === mode.key
            return (
              <button
                key={mode.key}
                onClick={() => !isActive && savePipelineMode(mode.key)}
                disabled={savingMode}
                className={`text-left p-4 rounded-lg border-2 transition-colors ${
                  isActive ? 'border-gray-900 bg-gray-50' : 'border-gray-200 hover:border-gray-400'
                } disabled:opacity-50`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                  <span className="font-semibold text-gray-900">{mode.label}</span>
                </div>
                <p className="text-sm text-gray-600">{mode.description}</p>
                <div className="mt-2 flex gap-3 text-xs text-gray-500">
                  <span>Transcribe: {mode.transcribe} concurrent</span>
                  <span>Summarize: {mode.summarize} concurrent</span>
                </div>
              </button>
            )
          })}
        </div>
        <p className="text-xs text-gray-400">Workers check for mode changes every 30 seconds.</p>
      </div>

      {/* Compliance Settings */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">Compliance Checks</h3>

        {/* Check toggles */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {[
            { key: 'profanity', label: 'Profanity Scan', cost: 'Free' },
            { key: 'station_id_missing', label: 'Station ID Check', cost: 'Free' },
            { key: 'technical', label: 'Technical Issues', cost: 'Free' },
            { key: 'payola_plugola', label: 'Payola/Plugola', cost: '~$0.002/ep' },
            { key: 'sponsor_id', label: 'Sponsor ID', cost: '~$0.002/ep' },
          ].map(({ key, label, cost }) => (
            <button
              key={key}
              onClick={() => toggleComplianceCheck(key)}
              className={`text-left p-3 rounded-lg border-2 transition-colors ${
                complianceChecks[key] ? 'border-emerald-500 bg-emerald-50' : 'border-gray-200 bg-gray-50'
              }`}
            >
              <div className="flex items-center gap-2 mb-0.5">
                <div className={`w-2 h-2 rounded-full ${complianceChecks[key] ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                <span className="text-sm font-medium text-gray-900">{label}</span>
              </div>
              <span className="text-[10px] text-gray-400">{cost}</span>
            </button>
          ))}
        </div>

        {/* Profanity Wordlist */}
        <div className="border-t pt-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Profanity Wordlist</h4>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addWord()}
              placeholder="Add word..."
              className="flex-1 border rounded px-2 py-1.5 text-sm"
            />
            <select
              value={newWordSeverity}
              onChange={(e) => setNewWordSeverity(e.target.value as 'critical' | 'warning')}
              className="border rounded px-2 py-1.5 text-sm"
            >
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
            </select>
            <button onClick={addWord} className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-700">
              Add
            </button>
          </div>
          {wordlist.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {wordlist.map((w) => (
                <span
                  key={w.id}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
                    !w.active ? 'opacity-40 bg-gray-50 border-gray-200' :
                    w.severity === 'critical' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-amber-50 border-amber-200 text-amber-700'
                  }`}
                >
                  {w.word}
                  <button onClick={() => toggleWord(w.id, w.active)} className="hover:opacity-70" title={w.active ? 'Disable' : 'Enable'}>
                    {w.active ? '\u2022' : '\u25CB'}
                  </button>
                  <button onClick={() => setDeleteConfirm({ id: w.id, type: 'word' })} className="hover:opacity-70">&times;</button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">No words in the profanity list.</p>
          )}
        </div>

        {/* AI Compliance Prompt */}
        <div className="border-t pt-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">AI Compliance Prompt</h4>
          <textarea
            value={compliancePrompt}
            onChange={(e) => setCompliancePrompt(e.target.value)}
            rows={6}
            className="w-full border rounded px-2 py-1.5 text-sm font-mono"
          />
          <button
            onClick={saveCompliancePrompt}
            disabled={saving === 'compliance_prompt'}
            className="mt-2 px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
          >
            {saving === 'compliance_prompt' ? 'Saving...' : 'Save Prompt'}
          </button>
        </div>
      </div>

      {/* QIR Settings */}
      <div className="bg-white rounded-lg shadow p-4 space-y-4">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">QIR Settings</h3>
        {settingFields.map((field) => (
          <div key={field.key} className="flex flex-col gap-1">
            <label className="text-sm font-medium text-gray-700">{field.label}</label>
            <div className="flex gap-2">
              {field.type === 'textarea' || field.type === 'json' ? (
                <textarea
                  value={editValues[field.key] ?? ''}
                  onChange={(e) => setEditValues({ ...editValues, [field.key]: e.target.value })}
                  rows={field.type === 'textarea' ? 4 : 3}
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

      {/* Transcript Corrections (lazy-loaded) */}
      <TranscriptCorrections
        corrections={corrections}
        onSaveCorrection={handleSaveCorrection}
        onToggleCorrection={handleToggleCorrection}
        onDeleteCorrection={handleDeleteCorrection}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={deleteConfirm !== null}
        title="Confirm Delete"
        message={deleteConfirm?.type === 'word' ? 'Remove this word from the profanity list?' : 'Delete this correction?'}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={executeDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}
