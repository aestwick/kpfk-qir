'use client'

import { useEffect, useState, useCallback, useRef, Fragment } from 'react'
import { authedFetch } from '@/lib/api-client'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import { DEFAULT_SUMMARIZATION_PROMPT, DEFAULT_CURATION_PROMPT } from '@/lib/settings'
import { resolveGroupDisplayName, showGroupKey, DEFAULT_SHOW_LANGUAGE } from '@/lib/shows'
import { generatePassphrase } from '@/lib/passphrase'
import type { StationMember, StationRole } from '@/lib/types'
import { episodeHref } from '@/lib/nav'

/* ─── lazy-loaded corrections component ─── */
const TranscriptCorrections = dynamic(() => import('@/app/components/transcript-corrections').then(m => ({ default: m.TranscriptCorrections })), {
  loading: () => <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark"><div className="h-48 bg-gray-100 rounded animate-pulse dark:bg-warm-700" /></div>,
  ssr: false,
})

const BulkShowEntry = dynamic(() => import('@/app/components/bulk-show-entry').then(m => ({ default: m.BulkShowEntry })), {
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
  show_group: string | null
  feed_name: string | null
  display_name: string | null
  category: string | null
  default_category: string | null
  primary_language: string | null
  active: boolean
  email: string | null
  archived_at: string | null
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
  { key: 'excluded_show_keys', label: 'Excluded Show Keys (JSON array)', type: 'json' },
  { key: 'summarization_model', label: 'Summarization Model', type: 'text', autoSave: true },
  { key: 'transcription_model', label: 'Transcription Model', type: 'text', autoSave: true },
  { key: 'transcribe_batch_size', label: 'Transcribe Batch Size', type: 'number', autoSave: true },
  { key: 'summarize_batch_size', label: 'Summarize Batch Size', type: 'number', autoSave: true },
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

type Tab = 'pipeline' | 'prompts' | 'shows' | 'compliance' | 'corrections' | 'members'


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
  const [summarizationPrompt, setSummarizationPrompt] = useState('')
  const [savedSummarizationPrompt, setSavedSummarizationPrompt] = useState('')
  const [curationPrompt, setCurationPrompt] = useState('')
  const [savedCurationPrompt, setSavedCurationPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; type: 'word' | 'correction' } | null>(null)

  // Fix dates state
  const [fixDatesFrom, setFixDatesFrom] = useState('')
  const [fixDatesTo, setFixDatesTo] = useState('')
  const [fixDatesLoading, setFixDatesLoading] = useState(false)
  const [fixDatesResult, setFixDatesResult] = useState<string | null>(null)

  // Shows tab state
  const [shows, setShows] = useState<Show[]>([])
  // Per-station prefixes stripped from auto-derived show names (e.g. "KPFK -").
  const [stripPrefixes, setStripPrefixes] = useState<string[] | null>(null)
  const [showSearch, setShowSearch] = useState('')
  // Which lifecycle state to show: live working set (all = active+inactive),
  // just active, just inactive, or archived (soft-deleted) shows.
  const [showStatusFilter, setShowStatusFilter] = useState<'all' | 'active' | 'inactive' | 'archived'>('all')
  const [editingShow, setEditingShow] = useState<{ id: number; field: string } | null>(null)
  const [editingShowValue, setEditingShowValue] = useState('')
  const [savingShow, setSavingShow] = useState<number | null>(null)
  const showEditRef = useRef<HTMLInputElement | HTMLSelectElement>(null)
  const showEditCancelled = useRef(false)

  // CSV import state
  const [csvImporting, setCsvImporting] = useState(false)
  const csvFileRef = useRef<HTMLInputElement>(null)

  // Pipeline health state
  const [healthCounts, setHealthCounts] = useState<Record<string, number>>({})
  const [errorEpisodes, setErrorEpisodes] = useState<Array<{
    id: number; show_key: string; show_name: string | null; air_date: string | null
    status: string; error_message: string | null; created_at: string; updated_at: string | null; retry_count: number | null
  }>>([])
  const [stuckEpisodes, setStuckEpisodes] = useState<typeof errorEpisodes>([])
  const [healthLoading, setHealthLoading] = useState(false)

  // Members tab state (only populated/shown for station admins)
  const [members, setMembers] = useState<StationMember[]>([])
  const [canManageMembers, setCanManageMembers] = useState(false)
  // Cost/spend figures (e.g. per-check pricing hints) are super-admin-only.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [newMember, setNewMember] = useState<{ email: string; password: string; role: StationRole }>({ email: '', password: '', role: 'viewer' })
  const [memberBusy, setMemberBusy] = useState(false)

  // Auto-save debounce timers
  const autoSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Categories from settings
  const categories: string[] = (() => {
    const cats = settings.issue_categories
    if (Array.isArray(cats)) return cats as string[]
    return DEFAULT_CATEGORIES
  })()

  // Excluded show KEYS from settings (drives the per-feed "Exclude" checkboxes).
  // Per-key, not per-name: dropping dn9 must not touch dn6. Stored as a JSON
  // array; tolerate either a parsed array or a JSON string.
  const excludedShowKeys: string[] = (() => {
    const v = settings.excluded_show_keys
    if (Array.isArray(v)) return v as string[]
    if (typeof v === 'string') {
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
    }
    return []
  })()
  const excludedKeySet = new Set(excludedShowKeys.map((k) => k.trim()))

  const { toast } = useToast()

  const fetchAll = useCallback(async () => {
    const [settingsRes, correctionsRes, wordlistRes, showsRes] = await Promise.all([
      authedFetch('/api/settings'),
      authedFetch('/api/corrections'),
      authedFetch('/api/compliance/wordlist'),
      authedFetch('/api/settings?resource=shows'),
    ])
    if (settingsRes.ok) {
      const data = await settingsRes.json()
      setSettings(data.settings ?? {})
      const vals: Record<string, string> = {}
      for (const field of settingFields) {
        const v = data.settings?.[field.key]
        if (field.type === 'json') {
          // These JSON settings are all arrays; default a missing one to [] so a
          // not-yet-saved setting (e.g. excluded_shows) renders/saves cleanly.
          vals[field.key] = typeof v === 'string' ? v : JSON.stringify(v ?? [], null, 2)
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
      const sumPrompt = (data.settings?.summarization_prompt as string) || DEFAULT_SUMMARIZATION_PROMPT
      setSummarizationPrompt(sumPrompt)
      setSavedSummarizationPrompt(sumPrompt)
      const curPrompt = (data.settings?.curation_prompt as string) || DEFAULT_CURATION_PROMPT
      setCurationPrompt(curPrompt)
      setSavedCurationPrompt(curPrompt)
    }
    if (correctionsRes.ok) {
      const data = await correctionsRes.json()
      setCorrections(data.corrections ?? [])
    }
    if (wordlistRes.ok) {
      const data = await wordlistRes.json()
      setWordlist(data.words ?? [])
      setIsSuperAdmin(!!data.isSuperAdmin)
    }
    if (showsRes.ok) {
      const data = await showsRes.json()
      setShows(data.shows ?? [])
      setStripPrefixes(data.stripPrefixes ?? null)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // Re-pull just the shows list (used after bulk-adding show keys).
  const refreshShows = useCallback(async () => {
    const res = await authedFetch('/api/settings?resource=shows')
    if (res.ok) {
      const data = await res.json()
      setShows(data.shows ?? [])
      setStripPrefixes(data.stripPrefixes ?? null)
    }
  }, [])

  // Re-resolve <category> from each feed for shows that never got one (e.g. added
  // via "Discover from archive", which carries key+name only). The feed category
  // is what the excluded_categories pull/coverage filters match on.
  const [backfilling, setBackfilling] = useState(false)
  const backfillCategories = useCallback(async () => {
    setBackfilling(true)
    try {
      const res = await authedFetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backfill-categories' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to queue category backfill'); return }
      toast('success', 'Category backfill queued — refresh in a minute to see resolved categories')
    } catch {
      toast('error', 'Network error: could not reach server')
    } finally {
      setBackfilling(false)
    }
  }, [toast])

  // Fetch pipeline health data when pipeline tab is active
  const fetchHealth = useCallback(async () => {
    setHealthLoading(true)
    try {
      const res = await authedFetch('/api/episodes/counts?health=true')
      if (res.ok) {
        const data = await res.json()
        setHealthCounts(data.counts ?? {})
        setErrorEpisodes(data.errorEpisodes ?? [])
        setStuckEpisodes(data.stuckEpisodes ?? [])
      }
    } catch {
      // silent
    }
    setHealthLoading(false)
  }, [])

  useEffect(() => {
    if (activeTab === 'pipeline') fetchHealth()
  }, [activeTab, fetchHealth])

  // Unsaved changes warning for prompts
  useEffect(() => {
    const hasUnsaved = settingFields.some(f =>
      (f.type === 'textarea' || f.type === 'json') && editValues[f.key] !== savedValues[f.key]
    ) || compliancePrompt !== savedCompliancePrompt
      || summarizationPrompt !== savedSummarizationPrompt
      || curationPrompt !== savedCurationPrompt

    if (!hasUnsaved) return

    function handler(e: BeforeUnloadEvent) {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [editValues, savedValues, compliancePrompt, savedCompliancePrompt])

  // Load members; a non-admin gets 403, which simply hides the Members tab.
  const fetchMembers = useCallback(async () => {
    try {
      const res = await authedFetch('/api/members')
      if (!res.ok) { setCanManageMembers(false); return }
      const data = await res.json()
      setCanManageMembers(true)
      setMembers(data.members ?? [])
    } catch {
      setCanManageMembers(false)
    }
  }, [])

  useEffect(() => { fetchMembers() }, [fetchMembers])

  async function copyPassword(text: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast('success', 'Password copied')
    } catch {
      toast('error', "Couldn't copy — copy it manually")
    }
  }

  async function addMember() {
    const email = newMember.email.trim()
    if (!email) return
    const hadPassword = newMember.password.trim().length > 0
    setMemberBusy(true)
    try {
      const res = await authedFetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: newMember.password || undefined, role: newMember.role }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast('error', data.error ?? 'Failed to add member'); return }
      // A password is ignored for an existing (shared-auth) account — say so.
      toast('success', data.created ? `Created ${email}` : hadPassword ? `Added ${email} — existing account, password unchanged` : `Added ${email}`)
      setNewMember({ email: '', password: '', role: 'viewer' })
      await fetchMembers()
    } finally {
      setMemberBusy(false)
    }
  }

  async function changeMemberRole(userId: string, role: StationRole) {
    const res = await authedFetch('/api/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, role }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) toast('error', data.error ?? 'Failed to update role')
    else toast('success', 'Role updated')
    await fetchMembers() // resync the selector either way
  }

  async function removeMember(userId: string, email: string | null) {
    if (!window.confirm(`Remove ${email ?? 'this member'} from this station?`)) return
    const res = await authedFetch(`/api/members?user_id=${encodeURIComponent(userId)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { toast('error', data.error ?? 'Failed to remove member'); return }
    toast('success', `Removed ${email ?? 'member'}`)
    await fetchMembers()
  }

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
      const res = await authedFetch('/api/settings', {
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
      const res = await authedFetch('/api/settings', {
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
      const res = await authedFetch('/api/settings', {
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
        ? await authedFetch('/api/corrections', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: editingId, ...form }) })
        : await authedFetch('/api/corrections', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      if (!res.ok) { toast('error', 'Failed to save correction'); return }
    } catch { toast('error', 'Network error'); return }
    fetchAll()
  }

  async function handleToggleCorrection(id: number, active: boolean) {
    try {
      await authedFetch('/api/corrections', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, active: !active }) })
    } catch { toast('error', 'Network error'); return }
    fetchAll()
  }

  async function handleDeleteCorrection(id: number) {
    setDeleteConfirm({ id, type: 'correction' })
  }

  async function executeDelete() {
    if (!deleteConfirm) return
    if (deleteConfirm.type === 'correction') {
      await authedFetch(`/api/corrections?id=${deleteConfirm.id}`, { method: 'DELETE' })
    } else {
      await authedFetch(`/api/compliance/wordlist?id=${deleteConfirm.id}`, { method: 'DELETE' })
    }
    setDeleteConfirm(null)
    fetchAll()
  }

  // Compliance wordlist handlers
  async function addWord() {
    if (!newWord.trim()) return
    await authedFetch('/api/compliance/wordlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: newWord.trim(), severity: newWordSeverity }),
    })
    setNewWord('')
    fetchAll()
  }

  async function toggleWord(id: number, active: boolean) {
    await authedFetch('/api/compliance/wordlist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: !active }),
    })
    fetchAll()
  }

  async function toggleComplianceCheck(checkType: string) {
    const updated = { ...complianceChecks, [checkType]: !complianceChecks[checkType] }
    setComplianceChecks(updated)
    await authedFetch('/api/settings', {
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
      const res = await authedFetch('/api/settings', {
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

  async function savePrompt(key: string, value: string, label: string, setSaved: (v: string) => void) {
    setSaving(key)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      if (res.ok) {
        setSaved(value)
        toast('success', `${label} saved`)
      } else {
        toast('error', `Failed to save ${label.toLowerCase()}`)
      }
    } catch {
      toast('error', 'Network error')
    }
    setSaving(null)
  }

  async function resetPromptToDefault(key: string, defaultValue: string, label: string, setCurrent: (v: string) => void, setSaved: (v: string) => void) {
    setSaving(key)
    try {
      // Delete the setting so the code falls back to the hardcoded default
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: null }),
      })
      if (res.ok) {
        setCurrent('')
        setSaved('')
        toast('success', `${label} reset to default`)
      } else {
        toast('error', `Failed to reset ${label.toLowerCase()}`)
      }
    } catch {
      toast('error', 'Network error')
    }
    setSaving(null)
  }

  // ── Fix dates handler ──

  async function handleBulkFixDates() {
    if (!fixDatesFrom || !fixDatesTo) {
      toast('error', 'Select both a start and end date')
      return
    }
    setFixDatesLoading(true)
    setFixDatesResult(null)
    try {
      const res = await authedFetch('/api/episodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'bulk-fix-dates', from: fixDatesFrom, to: fixDatesTo }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        setFixDatesResult(data.message ?? 'Done')
        toast('success', data.message ?? 'Dates fixed')
      } else {
        toast('error', data.error ?? 'Failed to fix dates')
      }
    } catch {
      toast('error', 'Network error')
    }
    setFixDatesLoading(false)
  }

  // ── Shows tab handlers ──

  function startShowEdit(show: Show, field: string) {
    setEditingShow({ id: show.id, field })
    if (field === 'show_name') setEditingShowValue(show.show_name)
    else if (field === 'display_name') setEditingShowValue(show.display_name ?? '')
    else if (field === 'show_group') setEditingShowValue(show.show_group ?? '')
    else if (field === 'category') setEditingShowValue(show.category ?? '')
    else if (field === 'default_category') setEditingShowValue(show.default_category ?? '')
    else if (field === 'primary_language') setEditingShowValue(show.primary_language ?? '')
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
    const value = field === 'show_name'
      ? editingShowValue.trim()
      : field === 'primary_language'
        ? (editingShowValue.trim().toLowerCase() || null)
        : field === 'display_name' || field === 'show_group'
          ? (editingShowValue.trim() || null)
          : (editingShowValue || null)
    try {
      const res = await authedFetch('/api/settings', {
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
      const res = await authedFetch('/api/settings', {
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

  // Archive (soft-delete) or restore a show key. Archiving hides it from the
  // default grid, stops it ingesting, and keeps discovery sync from re-importing
  // it; restoring clears the tombstone (leaving it inactive to re-activate).
  async function toggleShowArchived(show: Show) {
    const archiving = !show.archived_at
    setSavingShow(show.id)
    try {
      const res = await authedFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resource: 'show', id: show.id, archived: archiving }),
      })
      if (res.ok) {
        setShows(prev => prev.map(s => s.id === show.id
          ? { ...s, archived_at: archiving ? new Date().toISOString() : null, active: archiving ? false : s.active }
          : s))
      } else {
        toast('error', archiving ? 'Failed to archive show' : 'Failed to restore show')
      }
    } catch {
      toast('error', 'Network error')
    }
    setSavingShow(null)
  }

  // Add/remove a single feed from the excluded_show_keys blocklist (by show key).
  // Per-feed: excluding dn9 leaves the sibling dn6 untouched.
  async function toggleShowExcluded(show: Show) {
    const key = show.key.trim()
    const excluded = excludedKeySet.has(key)
    const next = excluded
      ? excludedShowKeys.filter((k) => k.trim() !== key)
      : [...excludedShowKeys, show.key]
    const nextJson = JSON.stringify(next, null, 2)

    // Optimistic update of both the derived list and the Pipeline-tab textarea.
    const prevSettings = settings
    const prevEdit = editValues.excluded_show_keys
    const prevSaved = savedValues.excluded_show_keys
    setSettings((prev) => ({ ...prev, excluded_show_keys: next }))
    setEditValues((prev) => ({ ...prev, excluded_show_keys: nextJson }))
    setSavedValues((prev) => ({ ...prev, excluded_show_keys: nextJson }))

    try {
      const res = await authedFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'excluded_show_keys', value: next }),
      })
      if (!res.ok) throw new Error('save failed')
    } catch {
      // Revert on failure.
      setSettings(prevSettings)
      setEditValues((prev) => ({ ...prev, excluded_show_keys: prevEdit }))
      setSavedValues((prev) => ({ ...prev, excluded_show_keys: prevSaved }))
      toast('error', 'Failed to update exclusion')
    }
  }

  // ── CSV import handler ──

  async function handleCsvImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvImporting(true)
    try {
      const text = await file.text()
      const res = await authedFetch('/api/corrections', {
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

  // ── Status counts (drive the Active/Inactive/Archived toggle) ──
  const statusCounts = {
    all: shows.filter((s) => !s.archived_at).length,
    active: shows.filter((s) => s.active && !s.archived_at).length,
    inactive: shows.filter((s) => !s.active && !s.archived_at).length,
    archived: shows.filter((s) => !!s.archived_at).length,
  }

  // ── Filtered shows ──
  const filteredShows = shows.filter(s => {
    // Lifecycle filter. Archived shows only appear in the 'archived' view; every
    // other view hides them (soft-deleted = out of the working set).
    if (showStatusFilter === 'archived') {
      if (!s.archived_at) return false
    } else {
      if (s.archived_at) return false
      if (showStatusFilter === 'active' && !s.active) return false
      if (showStatusFilter === 'inactive' && s.active) return false
    }
    if (!showSearch) return true
    const q = showSearch.toLowerCase()
    return [s.show_name, s.display_name, s.feed_name, s.key, s.show_group]
      .some((v) => v?.toLowerCase().includes(q))
  })

  // Group feeds by their explicit show_group (coalesce(show_group, key)) into one
  // logical show, so a multi-key program (e.g. a 6am + 9am airing) reads as a
  // single show with its keys listed under it. Grouping is by the group field,
  // never the name — names can differ across feeds. Keys stay individually
  // controllable (name override, group, active, exclude, category).
  const groupedShows = (() => {
    // Key by the case-insensitive merge key (showGroupKey) so feeds whose group
    // labels differ only by capitalization collapse into one logical show — same
    // grouping the QIR report uses.
    const byGroup = new Map<string, Show[]>()
    for (const s of filteredShows) {
      const g = showGroupKey(s)
      const list = byGroup.get(g) ?? []
      list.push(s)
      byGroup.set(g, list)
    }
    const groups = Array.from(byGroup.entries()).map(([group, feeds]) => ({
      group,
      shows: [...feeds].sort((a, b) => a.key.localeCompare(b.key)),
      name: resolveGroupDisplayName(feeds, stripPrefixes),
    }))
    return groups.sort((a, b) => a.name.localeCompare(b.name) || a.group.localeCompare(b.group))
  })()

  // Existing group labels (case-insensitively de-duped, keeping the first-seen
  // spelling) to suggest in the Group field — autocomplete without forcing a
  // choice, so a brand-new group can still be typed.
  const existingGroups = (() => {
    const seen = new Map<string, string>()
    for (const s of shows) {
      const label = s.show_group?.trim()
      if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label)
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b))
  })()

  if (loading) return (
    <div className="space-y-8">
      <h2 className="text-2xl font-bold">Settings</h2>
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'prompts', label: 'Prompts' },
    { key: 'shows', label: 'Shows', count: shows.length },
    { key: 'compliance', label: 'Compliance' },
    { key: 'corrections', label: 'Corrections', count: corrections.length },
    ...(canManageMembers ? [{ key: 'members' as Tab, label: 'Members', count: members.length }] : []),
  ]

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Settings</h2>

      {/* Tab bar */}
      <div className="flex gap-1 border-b dark:border-warm-700">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? 'border-gray-900 text-gray-900 dark:border-warm-100 dark:text-warm-100'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-warm-400 dark:hover:text-warm-300 dark:hover:border-warm-500'
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span className="ml-1.5 text-xs bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-full dark:bg-warm-700 dark:text-warm-400">{tab.count}</span>
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
          <div className="bg-white rounded-lg shadow p-4 space-y-3 dark:bg-surface-raised dark:shadow-card-dark">
            <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Processing Mode</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PIPELINE_MODES.map((mode) => {
                const isActive = pipelineMode === mode.key
                return (
                  <button
                    key={mode.key}
                    onClick={() => !isActive && savePipelineMode(mode.key)}
                    disabled={savingMode}
                    className={`text-left p-4 rounded-lg border-2 transition-colors ${
                      isActive ? 'border-gray-900 bg-gray-50 dark:border-warm-100 dark:bg-warm-700' : 'border-gray-200 hover:border-gray-400 dark:border-warm-600 dark:hover:border-warm-400'
                    } disabled:opacity-50`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <div className={`w-2.5 h-2.5 rounded-full ${isActive ? 'bg-green-500' : 'bg-gray-300 dark:bg-warm-500'}`} />
                      <span className="font-semibold text-gray-900 dark:text-warm-100">{mode.label}</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-warm-400">{mode.description}</p>
                    <div className="mt-2 flex gap-3 text-xs text-gray-500 dark:text-warm-400">
                      <span>Transcribe: {mode.transcribe} concurrent</span>
                      <span>Summarize: {mode.summarize} concurrent</span>
                    </div>
                  </button>
                )
              })}
            </div>
            <p className="text-xs text-gray-400 dark:text-warm-500">Workers check for mode changes every 30 seconds.</p>
          </div>

          {/* QIR Settings */}
          <div className="bg-white rounded-lg shadow p-4 space-y-4 dark:bg-surface-raised dark:shadow-card-dark">
            <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">QIR Settings</h3>
            {settingFields.map((field) => {
              const isDirty = (field.type === 'textarea' || field.type === 'json') && editValues[field.key] !== savedValues[field.key]
              const isAutoSave = field.autoSave
              return (
                <div key={field.key} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-gray-700 dark:text-warm-300">{field.label}</label>
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
                        className="flex-1 border rounded px-2 py-1.5 text-sm font-mono dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                      />
                    ) : (
                      <input
                        type={field.type === 'number' ? 'number' : 'text'}
                        value={editValues[field.key] ?? ''}
                        onChange={(e) => handleAutoSaveChange(field.key, e.target.value)}
                        className="flex-1 border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                      />
                    )}
                    {!isAutoSave && (
                      <div className="flex flex-col gap-1 shrink-0">
                        <button
                          onClick={() => saveSetting(field.key)}
                          disabled={saving === field.key || !isDirty}
                          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
                        >
                          {saving === field.key ? 'Saving...' : 'Save'}
                        </button>
                        {isDirty && (
                          <button
                            onClick={() => resetSetting(field.key)}
                            className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-300"
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

          {/* Pipeline Health */}
          <div className="bg-white rounded-lg shadow p-4 space-y-4 dark:bg-surface-raised dark:shadow-card-dark">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Pipeline Health</h3>
              <button
                onClick={fetchHealth}
                disabled={healthLoading}
                className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 disabled:opacity-50"
              >
                {healthLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>

            {/* Status Counts */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { key: 'pending', label: 'Pending', color: 'text-gray-600 dark:text-warm-400' },
                { key: 'transcribed', label: 'Transcribed', color: 'text-blue-600 dark:text-blue-400' },
                { key: 'summarized', label: 'Summarized', color: 'text-indigo-600 dark:text-indigo-400' },
                { key: 'compliance_checked', label: 'Compliance Checked', color: 'text-green-600 dark:text-green-400' },
                { key: 'failed', label: 'Failed', color: 'text-red-600 dark:text-red-400' },
                { key: 'transcript_missing', label: 'Transcript Missing', color: 'text-orange-600 dark:text-orange-400' },
                { key: 'unavailable', label: 'Unavailable', color: 'text-gray-400 dark:text-warm-500' },
                { key: 'dead', label: 'Dead', color: 'text-gray-400 dark:text-warm-500' },
              ].map(({ key, label, color }) => (
                <div key={key} className="border rounded-lg p-2.5 dark:border-warm-700">
                  <p className="text-xs text-gray-500 dark:text-warm-400">{label}</p>
                  <p className={`text-xl font-bold ${color}`}>{healthCounts[key] ?? 0}</p>
                </div>
              ))}
            </div>

            {/* Error Episodes */}
            {errorEpisodes.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                  Error Episodes ({errorEpisodes.length})
                </h4>
                <div className="overflow-x-auto max-h-64 overflow-y-auto border rounded-lg dark:border-warm-700">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0 dark:bg-warm-700">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">ID</th>
                        <th className="text-left px-2 py-1.5 font-medium">Show</th>
                        <th className="text-left px-2 py-1.5 font-medium">Date</th>
                        <th className="text-left px-2 py-1.5 font-medium">Status</th>
                        <th className="text-left px-2 py-1.5 font-medium">Error</th>
                        <th className="text-left px-2 py-1.5 font-medium">Retries</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-warm-700">
                      {errorEpisodes.map((ep) => (
                        <tr key={ep.id} className="hover:bg-gray-50 dark:hover:bg-warm-700/50">
                          <td className="px-2 py-1.5">
                            <a href={episodeHref(ep.id, '/dashboard/settings')} className="text-blue-600 hover:underline dark:text-blue-400">{ep.id}</a>
                          </td>
                          <td className="px-2 py-1.5 max-w-[120px] truncate" title={ep.show_name ?? ep.show_key}>
                            {ep.show_name ?? ep.show_key}
                          </td>
                          <td className="px-2 py-1.5 text-gray-500 dark:text-warm-400">{ep.air_date ?? '—'}</td>
                          <td className="px-2 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              ep.status === 'failed' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                              : ep.status === 'transcript_missing' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
                              : 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-300'
                            }`}>
                              {ep.status}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 max-w-[200px] truncate text-gray-500 dark:text-warm-400" title={ep.error_message ?? ''}>
                            {ep.error_message ?? '—'}
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500 dark:text-warm-400">{ep.retry_count ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Stuck Episodes */}
            {stuckEpisodes.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2">
                  Stuck Episodes ({stuckEpisodes.length})
                  <span className="text-xs font-normal text-gray-500 dark:text-warm-400 ml-2">
                    in pending/transcribed for &gt;2 hours
                  </span>
                </h4>
                <div className="overflow-x-auto max-h-48 overflow-y-auto border rounded-lg dark:border-warm-700">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0 dark:bg-warm-700">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-medium">ID</th>
                        <th className="text-left px-2 py-1.5 font-medium">Show</th>
                        <th className="text-left px-2 py-1.5 font-medium">Status</th>
                        <th className="text-left px-2 py-1.5 font-medium">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y dark:divide-warm-700">
                      {stuckEpisodes.map((ep) => (
                        <tr key={ep.id} className="hover:bg-gray-50 dark:hover:bg-warm-700/50">
                          <td className="px-2 py-1.5">
                            <a href={episodeHref(ep.id, '/dashboard/settings')} className="text-blue-600 hover:underline dark:text-blue-400">{ep.id}</a>
                          </td>
                          <td className="px-2 py-1.5 max-w-[150px] truncate">{ep.show_name ?? ep.show_key}</td>
                          <td className="px-2 py-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-medium dark:bg-amber-900/30 dark:text-amber-300">
                              {ep.status}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-gray-500 dark:text-warm-400">
                            {ep.updated_at ? new Date(ep.updated_at).toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {errorEpisodes.length === 0 && stuckEpisodes.length === 0 && !healthLoading && (
              <p className="text-sm text-green-600 dark:text-green-400">All clear — no stuck or error episodes.</p>
            )}
          </div>

          {/* Maintenance */}
          <div className="bg-white rounded-lg shadow p-4 space-y-3 dark:bg-surface-raised dark:shadow-card-dark">
            <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Maintenance</h3>

            <div>
              <p className="text-sm text-gray-600 dark:text-warm-400 mb-2">
                Re-derive air dates and times from MP3 URLs for episodes in a date range.
                This fixes dates that were wrong from the RSS feed. No re-transcription or AI tokens.
              </p>
              <div className="flex items-end gap-3 flex-wrap">
                <div>
                  <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">From</label>
                  <input
                    type="date"
                    value={fixDatesFrom}
                    onChange={(e) => setFixDatesFrom(e.target.value)}
                    className="border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">To</label>
                  <input
                    type="date"
                    value={fixDatesTo}
                    onChange={(e) => setFixDatesTo(e.target.value)}
                    className="border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                  />
                </div>
                <button
                  onClick={handleBulkFixDates}
                  disabled={fixDatesLoading || !fixDatesFrom || !fixDatesTo}
                  className="px-4 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
                >
                  {fixDatesLoading ? 'Fixing...' : 'Fix Dates from URLs'}
                </button>
              </div>
              {fixDatesResult && (
                <p className="text-sm text-green-600 dark:text-green-400 mt-2">{fixDatesResult}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Prompts Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'prompts' && (
        <div className="space-y-6">
          <p className="text-sm text-gray-600 dark:text-warm-400">
            Edit the AI prompts used by the pipeline. Changes take effect on the next processing run. If a prompt is empty, the built-in default is used.
          </p>

          {/* Summarization Prompt */}
          <div className="bg-white rounded-lg shadow p-4 space-y-3 dark:bg-surface-raised dark:shadow-card-dark">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-warm-100">Summarization Prompt</h3>
                <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5">
                  System prompt sent to OpenAI when summarizing each episode transcript. Controls headline, summary, host/guest extraction, and issue categorization.
                </p>
              </div>
            </div>
            <div className={summarizationPrompt !== savedSummarizationPrompt ? 'ring-2 ring-amber-300 rounded' : ''}>
              <textarea
                value={summarizationPrompt || ''}
                onChange={(e) => setSummarizationPrompt(e.target.value)}
                placeholder={DEFAULT_SUMMARIZATION_PROMPT}
                rows={16}
                className="w-full border rounded px-3 py-2 text-sm font-mono leading-relaxed dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100 placeholder:text-gray-400 dark:placeholder:text-warm-500 placeholder:whitespace-pre-wrap"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => savePrompt('summarization_prompt', summarizationPrompt, 'Summarization prompt', setSavedSummarizationPrompt)}
                disabled={saving === 'summarization_prompt' || summarizationPrompt === savedSummarizationPrompt}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                {saving === 'summarization_prompt' ? 'Saving...' : 'Save'}
              </button>
              {summarizationPrompt !== savedSummarizationPrompt && (
                <button
                  onClick={() => setSummarizationPrompt(savedSummarizationPrompt)}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-300"
                >
                  Discard changes
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={() => resetPromptToDefault('summarization_prompt', DEFAULT_SUMMARIZATION_PROMPT, 'Summarization prompt', setSummarizationPrompt, setSavedSummarizationPrompt)}
                disabled={saving === 'summarization_prompt' || summarizationPrompt === DEFAULT_SUMMARIZATION_PROMPT}
                className="px-3 py-1.5 text-xs text-red-600 hover:text-red-800 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
              >
                Reset to default
              </button>
            </div>
          </div>

          {/* Curation Prompt */}
          <div className="bg-white rounded-lg shadow p-4 space-y-3 dark:bg-surface-raised dark:shadow-card-dark">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-warm-100">Curation Prompt</h3>
                <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5">
                  System prompt sent to OpenAI when selecting episodes for the QIR draft. Controls how entries are prioritized and filtered for the final report.
                </p>
              </div>
            </div>
            <div className={curationPrompt !== savedCurationPrompt ? 'ring-2 ring-amber-300 rounded' : ''}>
              <textarea
                value={curationPrompt || ''}
                onChange={(e) => setCurationPrompt(e.target.value)}
                placeholder={DEFAULT_CURATION_PROMPT}
                rows={12}
                className="w-full border rounded px-3 py-2 text-sm font-mono leading-relaxed dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100 placeholder:text-gray-400 dark:placeholder:text-warm-500 placeholder:whitespace-pre-wrap"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => savePrompt('curation_prompt', curationPrompt, 'Curation prompt', setSavedCurationPrompt)}
                disabled={saving === 'curation_prompt' || curationPrompt === savedCurationPrompt}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                {saving === 'curation_prompt' ? 'Saving...' : 'Save'}
              </button>
              {curationPrompt !== savedCurationPrompt && (
                <button
                  onClick={() => setCurationPrompt(savedCurationPrompt)}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-300"
                >
                  Discard changes
                </button>
              )}
              <div className="flex-1" />
              <button
                onClick={() => resetPromptToDefault('curation_prompt', DEFAULT_CURATION_PROMPT, 'Curation prompt', setCurationPrompt, setSavedCurationPrompt)}
                disabled={saving === 'curation_prompt' || curationPrompt === DEFAULT_CURATION_PROMPT}
                className="px-3 py-1.5 text-xs text-red-600 hover:text-red-800 disabled:opacity-50 dark:text-red-400 dark:hover:text-red-300"
              >
                Reset to default
              </button>
            </div>
          </div>

          {/* Compliance Prompt */}
          <div className="bg-white rounded-lg shadow p-4 space-y-3 dark:bg-surface-raised dark:shadow-card-dark">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-warm-100">Compliance Prompt</h3>
                <p className="text-xs text-gray-500 dark:text-warm-400 mt-0.5">
                  System prompt for AI-powered compliance checks (payola/plugola, sponsor ID, indecency). Also editable from the Compliance tab.
                </p>
              </div>
            </div>
            <div className={compliancePrompt !== savedCompliancePrompt ? 'ring-2 ring-amber-300 rounded' : ''}>
              <textarea
                value={compliancePrompt}
                onChange={(e) => setCompliancePrompt(e.target.value)}
                rows={10}
                className="w-full border rounded px-3 py-2 text-sm font-mono leading-relaxed dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveCompliancePrompt}
                disabled={saving === 'compliance_prompt' || compliancePrompt === savedCompliancePrompt}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                {saving === 'compliance_prompt' ? 'Saving...' : 'Save'}
              </button>
              {compliancePrompt !== savedCompliancePrompt && (
                <button
                  onClick={() => setCompliancePrompt(savedCompliancePrompt)}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-300"
                >
                  Discard changes
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Shows Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'shows' && (
        <div className="bg-white rounded-lg shadow p-4 space-y-4 dark:bg-surface-raised dark:shadow-card-dark">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Shows ({shows.length})</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={backfillCategories}
                disabled={backfilling}
                title="Re-resolve the feed category for shows that don't have one. Needed for the Music/Español exclusion (ingest pull + coverage gaps) to work."
                className="border rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-warm-600 dark:text-warm-300 dark:hover:bg-warm-800"
              >
                {backfilling ? 'Queuing…' : 'Backfill categories'}
              </button>
              <input
                type="text"
                value={showSearch}
                onChange={(e) => setShowSearch(e.target.value)}
                placeholder="Filter shows..."
                className="border rounded px-3 py-1.5 text-sm w-64 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
              />
            </div>
          </div>

          {/* Lifecycle filter: live working set, just active/inactive, or the
              archived (soft-deleted) shows. */}
          <div className="inline-flex rounded-md border overflow-hidden text-sm dark:border-warm-600">
            {([
              { key: 'all', label: 'All' },
              { key: 'active', label: 'Active' },
              { key: 'inactive', label: 'Inactive' },
              { key: 'archived', label: 'Archived' },
            ] as const).map((f) => (
              <button
                key={f.key}
                onClick={() => setShowStatusFilter(f.key)}
                className={`px-3 py-1.5 border-l first:border-l-0 dark:border-warm-600 transition-colors ${
                  showStatusFilter === f.key
                    ? 'bg-gray-900 text-white dark:bg-warm-100 dark:text-warm-900'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-warm-300 dark:hover:bg-warm-800'
                }`}
              >
                {f.label}
                <span className={`ml-1.5 text-xs ${showStatusFilter === f.key ? 'opacity-80' : 'text-gray-400 dark:text-warm-500'}`}>
                  {statusCounts[f.key]}
                </span>
              </button>
            ))}
          </div>

          <BulkShowEntry
            existingKeys={shows.map((s) => s.key)}
            onAdded={refreshShows}
            toast={toast}
          />

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b dark:bg-warm-700 dark:border-warm-600">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Key</th>
                  <th className="text-left px-3 py-2 font-medium" title="Displayed name. Override (display_name) wins over the RSS-derived feed name. Edits the representative feed for the group.">Name</th>
                  <th className="text-left px-3 py-2 font-medium" title="Grouping identity. Give two feeds the same group to merge them into one logical show in the QIR picker and report. Blank = standalone (the key is its own group).">Group</th>
                  <th className="text-left px-3 py-2 font-medium" title="iTunes feed category from the RSS (e.g. News & Politics)">Category</th>
                  <th className="text-left px-3 py-2 font-medium" title="FCC issue category applied to summaries">Default Category</th>
                  <th className="text-left px-3 py-2 font-medium">Language</th>
                  <th className="text-center px-3 py-2 font-medium">Active</th>
                  <th className="text-center px-3 py-2 font-medium" title="Exclude this feed (show key) from ingest. Only this key is dropped — other airings of the same show keep running.">Exclude</th>
                  <th className="text-right px-3 py-2 font-medium">Episodes</th>
                  <th className="text-center px-3 py-2 font-medium" title="Archive (soft-delete) a show key: hides it here, stops ingest, and keeps discovery sync from re-importing it. Restore brings it back.">Archive</th>
                </tr>
              </thead>
              <tbody className="divide-y dark:divide-warm-700">
                {filteredShows.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-6 text-center text-gray-500 dark:text-warm-400">
                    {showSearch || showStatusFilter !== 'all' ? 'No shows match your filter' : 'No shows found'}
                  </td></tr>
                ) : groupedShows.map((group) => (
                  <Fragment key={group.shows[0].id}>
                    {group.shows.map((show, idx) => (
                  <tr key={show.id} className={`${idx === 0 ? 'border-t-2 border-gray-200 dark:border-warm-600' : ''} ${!show.active ? 'opacity-50' : ''} ${savingShow === show.id ? 'opacity-70' : ''}`}>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500 dark:text-warm-400">{show.key}</td>
                    {idx === 0 && (
                    <td className="px-3 py-2 align-top" rowSpan={group.shows.length}>
                      {editingShow?.id === show.id && editingShow.field === 'display_name' ? (
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
                          placeholder={show.feed_name ?? show.show_name}
                          className="border rounded px-2 py-0.5 text-sm w-full dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                        />
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'display_name')}
                          className="text-left hover:text-blue-600 hover:underline cursor-pointer dark:text-warm-100"
                          title="Click to edit the display name (override)"
                        >
                          {group.name}
                          {group.shows.length > 1 && (
                            <span className="ml-1 text-xs text-gray-400 dark:text-warm-500">({group.shows.length} feeds)</span>
                          )}
                          {/* Show the RSS-derived feed name when it isn't already what we're displaying. */}
                          {show.feed_name && show.feed_name !== group.name && (
                            <span className="block text-xs text-gray-400 dark:text-warm-500">RSS: {show.feed_name}</span>
                          )}
                        </button>
                      )}
                    </td>
                    )}
                    <td className="px-3 py-2">
                      {editingShow?.id === show.id && editingShow.field === 'show_group' ? (
                        <input
                          ref={showEditRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          list="show-groups"
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
                          placeholder={show.key}
                          className="border rounded px-2 py-0.5 text-xs w-28 font-mono dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                        />
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'show_group')}
                          className="block text-left hover:text-blue-600 cursor-pointer font-mono text-xs border border-transparent rounded px-2 py-0.5 w-28 truncate"
                          title="Click to edit. Set the same group on multiple feeds to merge them into one logical show."
                        >
                          {show.show_group
                            ? <span className="text-gray-700 dark:text-warm-200">{show.show_group}</span>
                            : <span className="text-gray-300 italic dark:text-warm-500">{show.key}</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingShow?.id === show.id && editingShow.field === 'category' ? (
                        <input
                          ref={showEditRef as React.RefObject<HTMLInputElement>}
                          type="text"
                          list="show-itunes-categories"
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
                          placeholder="e.g. News & Politics"
                          className="border rounded px-2 py-0.5 text-sm w-full dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                        />
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'category')}
                          className="text-left hover:text-blue-600 cursor-pointer text-gray-600 dark:text-warm-400"
                          title="Click to edit"
                        >
                          {show.category || <span className="text-gray-300 italic dark:text-warm-500">None</span>}
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
                            authedFetch('/api/settings', {
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
                          className="border rounded px-2 py-0.5 text-sm w-full dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                        >
                          <option value="">None</option>
                          {categories.map(cat => (
                            <option key={cat} value={cat}>{cat}</option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'default_category')}
                          className="text-left hover:text-blue-600 cursor-pointer text-gray-600 dark:text-warm-400"
                          title="Click to edit"
                        >
                          {show.default_category || <span className="text-gray-300 italic dark:text-warm-500">None</span>}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editingShow?.id === show.id && editingShow.field === 'primary_language' ? (
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
                          placeholder="e.g. en"
                          className="border rounded px-2 py-0.5 text-sm w-20 dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
                        />
                      ) : (
                        <button
                          onClick={() => startShowEdit(show, 'primary_language')}
                          className="text-left hover:text-blue-600 cursor-pointer text-gray-600 dark:text-warm-400"
                          title="Click to edit"
                        >
                          {show.primary_language || (
                            <span
                              className="text-gray-300 italic dark:text-warm-500"
                              title="No language set — defaults to English"
                            >
                              {DEFAULT_SHOW_LANGUAGE}
                            </span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => toggleShowActive(show)}
                        disabled={savingShow === show.id}
                        className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                          show.active
                            ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300 dark:hover:bg-green-900/50'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-warm-700 dark:text-warm-400 dark:hover:bg-warm-600'
                        }`}
                      >
                        {show.active ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={excludedKeySet.has(show.key)}
                        onChange={() => toggleShowExcluded(show)}
                        className="h-4 w-4 cursor-pointer accent-red-600"
                        title="Exclude this feed (show key) from ingest"
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <a
                        href={`/dashboard/episodes?show=${encodeURIComponent(show.key)}`}
                        className="text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        {show.episode_count}
                      </a>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {show.archived_at ? (
                        <button
                          onClick={() => toggleShowArchived(show)}
                          disabled={savingShow === show.id}
                          className="text-xs px-2.5 py-1 rounded-full font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
                          title="Restore this show key (undelete)"
                        >
                          Restore
                        </button>
                      ) : (
                        <button
                          onClick={() => toggleShowArchived(show)}
                          disabled={savingShow === show.id}
                          className="text-xs px-2.5 py-1 rounded-full font-medium text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-warm-500 dark:hover:bg-red-900/20 dark:hover:text-red-400"
                          title="Archive (soft-delete) this show key"
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <datalist id="show-itunes-categories">
              {['Arts','Business','Comedy','Education','Games & Hobbies','Government & Organizations','Health','Kids & Family','Music','News & Politics','Religion & Spirituality','Science & Medicine','Society & Culture','Sports & Recreation','Technology','TV & Film'].map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            <datalist id="show-groups">
              {existingGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════ */}
      {/* Compliance Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'compliance' && (
        <div className="bg-white rounded-lg shadow p-4 space-y-4 dark:bg-surface-raised dark:shadow-card-dark">
          <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Compliance Checks</h3>

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
                  complianceChecks[key] ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30 dark:border-emerald-400' : 'border-gray-200 bg-gray-50 dark:border-warm-600 dark:bg-warm-700'
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <div className={`w-2 h-2 rounded-full ${complianceChecks[key] ? 'bg-emerald-500' : 'bg-gray-300 dark:bg-warm-500'}`} />
                  <span className="text-sm font-medium text-gray-900 dark:text-warm-100">{label}</span>
                </div>
                {isSuperAdmin && <span className="text-[10px] text-gray-400 dark:text-warm-500">{cost}</span>}
              </button>
            ))}
          </div>

          {/* Profanity Wordlist */}
          <div className="border-t pt-4 dark:border-warm-700">
            <h4 className="text-sm font-medium text-gray-700 mb-2 dark:text-warm-300">Profanity Wordlist</h4>
            <div className="flex gap-2 mb-3">
              <input
                type="text"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addWord()}
                placeholder="Add word..."
                className="flex-1 border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
              />
              <select
                value={newWordSeverity}
                onChange={(e) => setNewWordSeverity(e.target.value as 'critical' | 'warning')}
                className="border rounded px-2 py-1.5 text-sm dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
              >
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
              </select>
              <button onClick={addWord} className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-700 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100">
                Add
              </button>
            </div>
            {wordlist.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {wordlist.map((w) => (
                  <span
                    key={w.id}
                    className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
                      !w.active ? 'opacity-40 bg-gray-50 border-gray-200 dark:bg-warm-700 dark:border-warm-600' :
                      w.severity === 'critical' ? 'bg-red-50 border-red-200 text-red-700 dark:bg-red-900/30 dark:border-red-800 dark:text-red-300' : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-900/30 dark:border-amber-800 dark:text-amber-300'
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
              <p className="text-xs text-gray-400 dark:text-warm-500">No words in the profanity list.</p>
            )}
          </div>

          {/* AI Compliance Prompt */}
          <div className="border-t pt-4 dark:border-warm-700">
            <h4 className="text-sm font-medium text-gray-700 mb-2 dark:text-warm-300">AI Compliance Prompt</h4>
            <div className={compliancePrompt !== savedCompliancePrompt ? 'ring-2 ring-amber-300 rounded' : ''}>
              <textarea
                value={compliancePrompt}
                onChange={(e) => setCompliancePrompt(e.target.value)}
                rows={6}
                className="w-full border rounded px-2 py-1.5 text-sm font-mono dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
              />
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={saveCompliancePrompt}
                disabled={saving === 'compliance_prompt' || compliancePrompt === savedCompliancePrompt}
                className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100"
              >
                {saving === 'compliance_prompt' ? 'Saving...' : 'Save Prompt'}
              </button>
              {compliancePrompt !== savedCompliancePrompt && (
                <button
                  onClick={() => setCompliancePrompt(savedCompliancePrompt)}
                  className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-300"
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
              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 dark:border-warm-600 dark:hover:bg-warm-700/50 dark:text-warm-200"
            >
              {csvImporting ? 'Importing...' : 'Import CSV'}
            </button>
            <span className="text-xs text-gray-400 dark:text-warm-500">
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

      {/* ════════════════════════════════════════════════════ */}
      {/* Members Tab */}
      {/* ════════════════════════════════════════════════════ */}
      {activeTab === 'members' && (
        <div className="space-y-6">
          <div>
            <h3 className="font-semibold text-sm text-gray-500 uppercase dark:text-warm-400">Station Members</h3>
            <p className="text-sm text-gray-600 dark:text-warm-400 mt-1">
              Who can access this station. <strong>Viewers</strong> are read-only;{' '}
              <strong>editors</strong> can run the pipeline and edit content;{' '}
              <strong>admins</strong> can also manage members.
            </p>
          </div>

          {/* Add / invite a member */}
          <div className="bg-white rounded-lg shadow p-4 dark:bg-surface-raised dark:shadow-card-dark">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[180px]">
                <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Email</label>
                <input
                  type="email"
                  value={newMember.email}
                  onChange={(e) => setNewMember({ ...newMember, email: e.target.value })}
                  placeholder="person@example.org"
                  className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                />
              </div>
              <div className="flex-1 min-w-[160px]">
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs text-gray-500 dark:text-warm-400">Password</label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setNewMember({ ...newMember, password: generatePassphrase() })}
                      className="text-2xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Generate
                    </button>
                    {newMember.password && (
                      <button
                        type="button"
                        onClick={() => copyPassword(newMember.password)}
                        className="text-2xs text-gray-500 hover:underline dark:text-warm-400"
                      >
                        Copy
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="text"
                  value={newMember.password}
                  onChange={(e) => setNewMember({ ...newMember, password: e.target.value })}
                  placeholder="New accounts only"
                  autoComplete="new-password"
                  className="w-full text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 dark:text-warm-400 mb-1">Role</label>
                <select
                  value={newMember.role}
                  onChange={(e) => setNewMember({ ...newMember, role: e.target.value as StationRole })}
                  className="text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                onClick={addMember}
                disabled={memberBusy || !newMember.email.trim()}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50 dark:bg-warm-100 dark:text-warm-900"
              >
                {memberBusy ? 'Adding…' : 'Add member'}
              </button>
            </div>
            <p className="text-xs text-gray-400 dark:text-warm-500 mt-2">
              Adding an existing account? Leave the password blank. For a new account, set a starting
              password and share it — no email is sent.
            </p>
          </div>

          {/* Member list */}
          <div className="bg-white rounded-lg shadow divide-y dark:bg-surface-raised dark:shadow-card-dark dark:divide-warm-700">
            {members.length === 0 && (
              <div className="p-4 text-sm text-gray-500 dark:text-warm-400">No members yet.</div>
            )}
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0 text-sm text-gray-900 dark:text-warm-100 truncate">
                  {m.email ?? m.user_id}
                  {m.is_self && <span className="text-gray-400 dark:text-warm-500"> (you)</span>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <select
                    value={m.role}
                    onChange={(e) => changeMemberRole(m.user_id, e.target.value as StationRole)}
                    className="text-sm rounded-lg px-2 py-1 border border-gray-300 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    onClick={() => removeMember(m.user_id, m.email)}
                    disabled={m.is_self}
                    title={m.is_self ? "You can't remove yourself" : 'Remove member'}
                    className="px-2 py-1 text-sm text-red-600 hover:text-red-700 disabled:opacity-40 dark:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
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
