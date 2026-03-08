'use client'

import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'

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
    description: 'Normal processing — 1 transcription, 5 summarizations at a time',
    transcribe: 1,
    summarize: 5,
  },
  {
    key: 'catch-up',
    label: 'Catch-up',
    description: 'Faster processing — 3 transcriptions, 10 summarizations at a time',
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
  const [loading, setLoading] = useState(true)

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
      if (data.settings?.pipeline_mode) {
        setPipelineMode(data.settings.pipeline_mode as string)
      }
    }
    if (correctionsRes.ok) {
      const data = await correctionsRes.json()
      setCorrections(data.corrections ?? [])
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
        toast('success', `Switched to ${preset?.label} mode — workers will pick this up within 30 seconds`)
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
        ? await fetch('/api/corrections', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: editingId, ...form }),
          })
        : await fetch('/api/corrections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to save correction')
        return
      }
    } catch {
      toast('error', 'Network error: could not reach server')
      return
    }
    fetchAll()
  }

  async function handleToggleCorrection(id: number, active: boolean) {
    try {
      const res = await fetch('/api/corrections', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: !active }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to toggle correction')
        return
      }
    } catch {
      toast('error', 'Network error: could not reach server')
      return
    }
    fetchAll()
  }

  async function handleDeleteCorrection(id: number) {
    if (!confirm('Delete this correction?')) return
    try {
      const res = await fetch(`/api/corrections?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to delete correction')
        return
      }
    } catch {
      toast('error', 'Network error: could not reach server')
      return
    }
    fetchAll()
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
                  isActive
                    ? 'border-gray-900 bg-gray-50'
                    : 'border-gray-200 hover:border-gray-400'
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

      {/* Transcript Corrections (lazy-loaded) */}
      <TranscriptCorrections
        corrections={corrections}
        onSaveCorrection={handleSaveCorrection}
        onToggleCorrection={handleToggleCorrection}
        onDeleteCorrection={handleDeleteCorrection}
      />
    </div>
  )
}
