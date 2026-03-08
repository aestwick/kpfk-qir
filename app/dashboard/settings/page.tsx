'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
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

interface Show {
  id: number
  key: string
  show_name: string
  category: string | null
  default_category: string | null
  active: boolean
  email: string | null
  created_at: string
  updated_at: string | null
  episode_count: number
}

interface SettingField {
  key: string
  label: string
  type: 'text' | 'number' | 'json' | 'textarea'
  autoSave?: boolean
}

const settingFields: SettingField[] = [
  { key: 'station_id', label: 'Station ID', type: 'text', autoSave: true },
  { key: 'max_entries_per_category', label: 'Max Entries Per Category', type: 'number', autoSave: true },
  { key: 'issue_categories', label: 'Issue Categories (JSON array)', type: 'json' },
  { key: 'excluded_categories', label: 'Excluded Categories (JSON array)', type: 'json' },
  { key: 'summarization_model', label: 'Summarization Model', type: 'text', autoSave: true },
  { key: 'transcription_model', label: 'Transcription Model', type: 'text', autoSave: true },
  { key: 'transcribe_batch_size', label: 'Transcribe Batch Size', type: 'number', autoSave: true },
  { key: 'summarize_batch_size', label: 'Summarize Batch Size', type: 'number', autoSave: true },
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

const DEFAULT_CATEGORIES = [
  'Civil Rights / Social Justice',
  'Immigration',
  'Economy / Labor',
  'Environment / Climate',
  'Government / Politics',
  'Health',
  'International Affairs / War & Peace',
  'Arts & Culture',
]

type Tab = 'pipeline' | 'shows' | 'compliance' | 'corrections'

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('pipeline')
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [savedValues, setSavedValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  const [pipelineMode, setPipelineMode] = useState('steady')
  const [savingMode, setSavingMode] = useState(false)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [wordlist, setWordlist] = useState<ComplianceWord[]>([])
  const [newWord, setNewWord] = useState('')
  const [newWordSeverity, setNewWordSeverity] = useState<'critical' | 'warning'>('critical')
  const [complianceChecks, setComplianceChecks] = useState<Record<string, boolean>>({})
  const [compliancePrompt, setCompliancePrompt] = useState('')
  const [savedCompliancePrompt, setSavedCompliancePrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; type: 'word' | 'correction' } | null>(null)

  // Shows tab state
  const [shows, setShows] = useState<Show[]>([])
  const [showSearch, setShowSearch] = useState('')
  const [editingShow, setEditingShow] = useState<{ id: number; field: string } | null>(null)
  const [editingShowValue, setEditingShowValue] = useState('')
  const [savingShow, setSavingShow] = useState<number | null>(null)
  const showEditRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const showEditCancelled = useRef(false)

  // CSV import state
  const [csvImporting, setCsvImporting] = useState(false)
  const csvFileRef = useRef<HTMLInputElement>(null)

  // Auto-save debounce timers
  const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Categories from settings
  const categories: string[] = (() => {
    const cats = settings.issue_categories
    if (Array.isArray(cats)) return cats as string[]
    return DEFAULT_CATEGORIES
  })()

  const fetchAll = useCallback(async () => {
    const [settingsRes, correctionsRes, wordlistRes, showsRes] = await Promise.all([
      fetch('/api/settings'),
      fetch('/api/corrections'),
      fetch('/api/compliance/wordlist'),
      fetch('/api/settings?resource=shows'),
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
      setSavedValues(vals)
      if (data.settings?.pipeline_mode) {
        setPipelineMode(data.settings.pipeline_mode as string)
      }
      if (data.settings?.compliance_checks_enabled) {
        setComplianceChecks(data.settings.compliance_checks_enabled as Record<string, boolean>)
      }
      if (data.settings?.compliance_prompt) {
        setCompliancePrompt(data.settings.compliance_prompt as string)
        setSavedCompliancePrompt(data.settings.compliance_prompt as string)
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
    if (showsRes.ok) {
      const data = await showsRes.json()
      setShows(data.shows ?? [])
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Unsaved changes warning for prompts
  useEffect(() => {
    const hasUnsaved = settingFields.some(f =>
      (f.type === 'textarea' || f.type === 'json') && editValues[f.key] !== savedValues[f.key]
    ) || compliancePrompt !== savedCompliancePrompt

    if (!hasUnsaved) return

    function handler(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [editValues, savedValues, compliancePrompt, savedCompliancePrompt])

  const { toast } = useToast()

  // Auto-save for constrained fields (text, number) — debounced 800ms
  function handleAutoSaveChange(key: string, value: string) {
    setEditValues(prev => ({ ...prev, [key]: value }))
    const field = settingFields.find(f => f.key === key)
    if (!field?.autoSave) return

    if (autoSaveTimers.current[key]) clearTimeout(autoSaveTimers.current[key])
    autoSaveTimers.current[key] = setTimeout(() => {
      autoSaveSetting(key, value, field)
    }, 800)
  }

  async function autoSaveSetting(key: string, rawValue: string, field: SettingField) {
    let value: unknown = rawValue
    if (field.type === 'number') {
      const num = Number(rawValue)
      if (isNaN(num)) return
      value = num
    }
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (res.ok) {
        setSavedValues(prev => ({ ...prev, [key]: rawValue }))
        setSavedFlash(key)
        setTimeout(() => setSavedFlash(prev => prev === key ? null : prev), 1500)
      }
    } catch {
      // silently fail for auto-save, user can manually retry
    }
  }

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
      if (res.ok) {
        setSavedValues(prev => ({ ...prev, [key]: editValues[key] }))
        toast('success', `${field?.label ?? key} saved`)
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? `Failed to save ${key}`)
      }
    } catch {
      toast('error', 'Network error: could not reach server')
    }
    setSaving(null)
  }

  function resetSetting(key: string) {
    setEditValues(prev => ({ ...prev, [key]: savedValues[key] }))
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
    if (!compliancePrompt.trim()) {
      toast('error', 'Compliance prompt cannot be empty')
      return
    }
    setSaving('compliance_prompt')
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'compliance_prompt', value: compliancePrompt }),
      })
      if (res.ok) {
        setSavedCompliancePrompt(compliancePrompt)
        toast('success', 'Compliance prompt saved')
      } else {
        toast('error', 'Failed to save compliance prompt')
      }
    } catch {
      toast('error', 'Network error')
    }
    setSaving(null)
  }

  // ── Shows tab handlers ──

  function startShowEdit(show: Show, field: string) {
    setEditingShow({ id: show.id, field })
    if (field === 'show_name') setEditingShowValue(show.show_name)
    else if (field === 'default_category') setEditingShowValue(show.default_category ?? '')
    setTimeout(() => showEditRef.current?.focus(), 0)
  }

  async function saveShowEdit(showId: number) {
    if (!editingShow || showEditCancelled.current) {
      showEditCancelled.current = false
      setEditingShow(null)
      return
    }
    const field = editingShow.field
    // Don't allow saving empty show_name
    if (field === 'show_name' && !editingShowValue.trim()) {
      toast('error', 'Show name cannot be empty')
      setEditingShow(null)
      return
    }
    setSavingShow(showId)
    const value = field === 'show_name' ? editingShowValue.trim() : (editingShowValue || null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'show', id: showId, [field]: value }),
      })
      if (res.ok) {
        setShows(prev => prev.map(s => s.id === showId ? { ...s, [field]: value } : s))
      } else {
        toast('error', 'Failed to update show')
      }
    } catch {
      toast('error', 'Network error')
    }
    setEditingShow(null)
    setSavingShow(null)
  }

  async function toggleShowActive(show: Show) {
    setSavingShow(show.id)
    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'show', id: show.id, active: !show.active }),
      })
      if (res.ok) {
        setShows(prev => prev.map(s => s.id === show.id ? { ...s, active: !s.active } : s))
      } else {
        toast('error', 'Failed to toggle show')
      }
    } catch {
      toast('error', 'Network error')
    }
    setSavingShow(null)
  }

  // ── CSV import handler ──

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvImporting(true)
    try {
      const text = await file.text()
      const res = await fetch('/api/corrections', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: text,
      })
      if (res.ok) {
        const data = await res.json()
        toast('success', `Imported ${data.count} corrections`)
        fetchAll()
      } else {
        const data = await res.json().catch(() => ({}))
        toast('error', data.error ?? 'Failed to import CSV')
      }
    } catch {
      toast('error', 'Network error during import')
    }
    setCsvImporting(false)
    if (csvFileRef.current) csvFileRef.current.value = ''
  }

  // ── Filtered shows ──
  const filteredShows = shows.filter(s =>
    !showSearch || s.show_name.toLowerCase().includes(showSearch.toLowerCase()) || s.key.toLowerCase().includes(showSearch.toLowerCase())
  )

  if (loading) return (
    <div className="space-y-8">
      <h2 className="text-2xl font-bold">Settings</h2>
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'shows', label: 'Shows', count: shows.length },
    { key: 'compliance', label: 'Compliance' },
    { key: 'corrections', label: 'Corrections', count: corrections.length },
  ]

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* Tab bar */}
      <div className="flex gap-1 border-b">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full">{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* ════════════════════════════════════════════════════ */}
      {/* Pipeline Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'pipeline' && (
        <div className="space-y-8">
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

          {/* QIR Settings */}
          <div className="bg-white rounded-lg shadow p-4 space-y-4">
            <h3 className="font-semibold text-sm text-gray-500 uppercase">QIR Settings</h3>
            {settingFields.map((field) => {
              const isDirty = (field.type === 'textarea' || field.type === 'json') && editValues[field.key] !== savedValues[field.key]
              const isAutoSave = field.autoSave
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-gray-700">{field.label}</label>
                    {savedFlash === field.key && (
                      <span className="text-xs text-green-600 font-medium animate-pulse">Saved</span>
                    )}
                  </div>
                  <div className={`flex gap-2 ${isDirty ? 'ring-2 ring-amber-300 rounded' : ''}`}>
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
                        onChange={(e) => handleAutoSaveChange(field.key, e.target.value)}
                        className="flex-1 border rounded px-2 py-1.5 text-sm"
                      />
                    )}
                    {!isAutoSave && (
                      <div className="flex flex-col gap-1 shrink-0">
                        <button
                          onClick={() => saveSetting(field.key)}
                          disabled={saving === field.key || !isDirty}
                          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
                        >
                          {saving === field.key ? 'Saving...' : 'Save'}
                        </button>
                        {isDirty && (
                          <button
                            onClick={() => resetSetting(field.key)}
                            className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Shows Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'shows' && (
        <div className="bg-white rounded-lg shadow p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm text-gray-500 uppercase">Shows ({shows.length})</h3>
            <input
              type="text"
              value={showSearch}
              onChange={(e) => setShowSearch(e.target.value)}
              placeholder="Search shows..."
              className="border rounded px-3 py-1.5 text-sm w-64"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Key</th>
                  <th className="text-left px-3 py-2 font-medium">Name</th>
                  <th className="text-left px-3 py-2 font-medium">Default Category</th>
                  <th className="text-center px-3 py-2 font-medium">Active</th>
                  <th className="text-right px-3 py-2 font-medium">Episodes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredShows.length === 0 ? (
                  <tr><td colSpan={5} className="px-3 py-6 text-center text-gray-500">
                    {showSearch ? 'No shows match your search' : 'No shows found'}
                  </td></tr>
                ) : filteredShows.map((show) => (
                  <tr key={show.id} className={`${!show.active ? 'opacity-50' : ''} ${savingShow === show.id ? 'opacity-70' : ''}`}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">{show.key}</td>
                    <td className="px-3 py-2">
                      {editingShow?.id === show.id && editingShow.field === 'show_name' ? (
                        <input
                          ref={showEditRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          value={editingShowValue}
                          onChange={(e) => setEditingShowValue(e.target.value)}
                          onBlur={() => saveShowEdit(show.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveShowEdit(show.id)
                            if (e.key === 'Escape') {
                              showEditCancelled.current = true
                              ;(e.target as HTMLInputElement).blur()
                            }
                          }}
                          className="border rounded px-2 py-0.5 text-sm w-full"
                        />
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'show_name')}
                          className="text-left hover:text-blue-600 hover:underline cursor-pointer"
                          title="Click to edit"
                        >
                          {show.show_name}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingShow?.id === show.id && editingShow.field === 'default_category' ? (
                        <select
                          ref={showEditRef as React.RefObject<HTMLSelectElement>}
                          value={editingShowValue}
                          onChange={(e) => {
                            setEditingShowValue(e.target.value)
                            // Auto-save on dropdown change
                            const val = e.target.value
                            setEditingShow(null)
                            setSavingShow(show.id)
                            fetch('/api/settings', {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ resource: 'show', id: show.id, default_category: val || null }),
                            }).then(res => {
                              if (res.ok) {
                                setShows(prev => prev.map(s => s.id === show.id ? { ...s, default_category: val || null } : s))
                              } else {
                                toast('error', 'Failed to update category')
                              }
                              setSavingShow(null)
                            }).catch(() => { toast('error', 'Network error'); setSavingShow(null) })
                          }}
                          onBlur={() => setEditingShow(null)}
                          className="border rounded px-2 py-0.5 text-sm w-full"
                        >
                          <option value="">None</option>
                          {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'default_category')}
                          className="text-left hover:text-blue-600 cursor-pointer text-gray-600"
                          title="Click to edit"
                        >
                          {show.default_category || <span className="text-gray-300 italic">None</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => toggleShowActive(show)}
                        disabled={savingShow === show.id}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                          show.active
                            ? 'bg-green-100 text-green-700 hover:bg-green-200'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                        }`}
                      >
                        {show.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <a
                        href={`/dashboard/episodes?show=${encodeURIComponent(show.key)}`}
                        className="text-blue-600 hover:underline"
                      >
                        {show.episode_count}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Compliance Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'compliance' && (
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
              { key: 'indecency', label: 'Indecency/Sexual Content', cost: '~$0.002/ep' },
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
            <div className={compliancePrompt !== savedCompliancePrompt ? 'ring-2 ring-amber-300 rounded' : ''}>
              <textarea
                value={compliancePrompt}
                onChange={(e) => setCompliancePrompt(e.target.value)}
                rows={6}
                className="w-full border rounded px-2 py-1.5 text-sm font-mono"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={saveCompliancePrompt}
                disabled={saving === 'compliance_prompt' || compliancePrompt === savedCompliancePrompt}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50"
              >
                {saving === 'compliance_prompt' ? 'Saving...' : 'Save Prompt'}
              </button>
              {compliancePrompt !== savedCompliancePrompt && (
                <button
                  onClick={() => setCompliancePrompt(savedCompliancePrompt)}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                >
                  Reset to saved
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Corrections Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'corrections' && (
        <div className="space-y-4">
          {/* CSV Import */}
          <div className="flex items-center gap-3">
            <input
              ref={csvFileRef}
              type="file"
              accept=".csv"
              onChange={handleCsvImport}
              className="hidden"
            />
            <button
              onClick={() => csvFileRef.current?.click()}
              disabled={csvImporting}
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
            >
              {csvImporting ? 'Importing...' : 'Import CSV'}
            </button>
            <span className="text-xs text-gray-400">
              CSV format: wrong, correct, case_sensitive, is_regex, notes
            </span>
          </div>

          <TranscriptCorrections
            corrections={corrections}
            onSaveCorrection={handleSaveCorrection}
            onToggleCorrection={handleToggleCorrection}
            onDeleteCorrection={handleDeleteCorrection}
          />
        </div>
      )}

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
