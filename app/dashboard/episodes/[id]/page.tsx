'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { ConfirmDialog } from '@/app/components/confirm-dialog'
import type { SeekToFn } from '@/app/components/episode-media'

/* ─── lazy-loaded media components ─── */
const AudioPlayerWithCaptions = dynamic(() => import('@/app/components/episode-media').then(m => ({ default: m.AudioPlayerWithCaptions })), {
  loading: () => <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4"><div className="h-32 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" /></div>,
  ssr: false,
})
const TranscriptViewer = dynamic(() => import('@/app/components/episode-media').then(m => ({ default: m.TranscriptViewer })), {
  loading: () => <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4"><div className="h-48 bg-gray-100 dark:bg-warm-700 rounded animate-pulse" /></div>,
  ssr: false,
})

interface Episode {
  id: number
  show_key: string
  show_name: string | null
  category: string | null
  date: string | null
  start_time: string | null
  end_time: string | null
  duration: number | null
  mp3_url: string
  status: string
  headline: string | null
  host: string | null
  guest: string | null
  summary: string | null
  transcript_url: string | null
  air_date: string | null
  air_start: string | null
  air_end: string | null
  issue_category: string | null
  error_message: string | null
  retry_count: number
  compliance_report: string | null
  created_at: string
  updated_at: string
}

interface Transcript {
  transcript: string | null
  vtt: string | null
  language: string | null
  english_transcript: string | null
  english_vtt: string | null
}

interface ComplianceFlag {
  id: number
  episode_id: number
  flag_type: string
  severity: string
  excerpt: string | null
  timestamp_seconds: number | null
  details: string | null
  resolved: boolean
  resolved_by: string | null
  resolved_notes: string | null
  created_at: string
}

const FLAG_TYPE_LABELS: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Missing Station ID',
  technical: 'Technical Issue',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID Missing',
  indecency: 'Indecency',
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/20 dark:text-red-300 dark:border-red-800/40',
  warning: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/20 dark:text-amber-300 dark:border-amber-800/40',
  info: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800/40',
}

const issueCategories = [
  'Civil Rights / Social Justice',
  'Immigration',
  'Economy / Labor',
  'Environment / Climate',
  'Government / Politics',
  'Health',
  'International Affairs / War & Peace',
  'Arts & Culture',
]

const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  transcribed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  summarized: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  compliance_checked: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  transcript_missing: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  unavailable: 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-400',
  dead: 'bg-gray-100 text-gray-600 dark:bg-warm-700 dark:text-warm-400',
}

function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const s = String(Math.floor(seconds % 60)).padStart(2, '0')
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`
}

/* ─── Inline Edit Field ─── */
function InlineEditField({
  value,
  field,
  episodeId,
  onSaved,
}: {
  value: string
  field: 'host' | 'guest'
  episodeId: string
  onSaved: (newValue: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState(value)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const savingRef = useRef(false) // Prevent double save from blur+Enter race

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus()
  }, [editing])

  async function save() {
    if (savingRef.current) return // Already saving — skip duplicate
    if (editValue === value) {
      setEditing(false)
      return
    }
    savingRef.current = true
    setSaving(true)
    const res = await fetch(`/api/episodes/${episodeId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: editValue || null }),
    })
    savingRef.current = false
    setSaving(false)
    if (res.ok) {
      onSaved(editValue)
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); save() }
          if (e.key === 'Escape') { setEditValue(value); setEditing(false) }
        }}
        disabled={saving}
        className="text-sm font-medium w-full border-b border-blue-400 dark:border-blue-500 outline-none bg-transparent py-0 dark:text-warm-100"
        placeholder={`Enter ${field}...`}
      />
    )
  }

  return (
    <p
      className="text-sm font-medium truncate cursor-pointer hover:text-blue-600 dark:hover:text-blue-400 group"
      onClick={() => { setEditValue(value); setEditing(true) }}
      title={`Click to edit ${field}`}
    >
      {value || '\u2014'}
      <span className="ml-1 text-gray-300 dark:text-warm-600 opacity-0 group-hover:opacity-100 text-xs">✎</span>
    </p>
  )
}

/* ─── Floating Correction Toolbar ─── */
function CorrectionToolbar({
  selectedText,
  position,
  episodeId,
  onClose,
  onSaved,
}: {
  selectedText: string
  position: { top: number; left: number }
  episodeId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [replacement, setReplacement] = useState('')
  const [isRegex, setIsRegex] = useState(false)
  const [scope, setScope] = useState<'global' | 'episode'>('global')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  async function handleSave() {
    if (!replacement.trim()) {
      setError('Replacement text is required')
      return
    }
    setError(null)
    setSaving(true)
    const body: Record<string, unknown> = {
      wrong: selectedText,
      correct: replacement,
      is_regex: isRegex,
      case_sensitive: false,
      active: true,
    }
    if (scope === 'episode') body.episode_id = Number(episodeId)
    const res = await fetch('/api/corrections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setSaving(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError(data.error ?? 'Failed to save correction')
      return
    }
    onSaved()
    onClose()
  }

  return (
    <div
      ref={toolbarRef}
      className="fixed z-50 bg-white dark:bg-surface-overlay rounded-lg shadow-lg border border-gray-200 dark:border-warm-600 p-2"
      style={{ top: position.top, left: position.left }}
    >
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-warm-300 hover:bg-gray-50 dark:hover:bg-warm-700 rounded whitespace-nowrap"
        >
          <span className="text-base leading-none">+</span> Add Transcript Correction
        </button>
      ) : (
        <div className="space-y-2 w-72">
          <div>
            <label className="text-[10px] text-gray-500 dark:text-warm-400 uppercase">Pattern</label>
            <div className="text-xs bg-gray-50 dark:bg-warm-700 rounded px-2 py-1 font-mono break-all">{selectedText}</div>
          </div>
          <div>
            <label className="text-[10px] text-gray-500 dark:text-warm-400 uppercase">Replacement</label>
            <input
              type="text"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              className="w-full border rounded px-2 py-1 text-xs dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
              placeholder="Replace with..."
              autoFocus
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-gray-600 dark:text-warm-400">
              <input type="checkbox" checked={isRegex} onChange={(e) => setIsRegex(e.target.checked)} className="rounded" />
              Regex
            </label>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'global' | 'episode')}
              className="text-xs border rounded px-1.5 py-0.5 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
            >
              <option value="global">All episodes</option>
              <option value="episode">This episode only</option>
            </select>
          </div>
          {error && <p className="text-[10px] text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-400 dark:hover:text-warm-200 px-2 py-1">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="text-xs px-3 py-1 bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Correction'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Toast message ─── */
function InlineToast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3000)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div className="fixed bottom-4 right-4 z-50 bg-emerald-600 text-white text-sm px-4 py-2 rounded-lg shadow-lg">
      {message}
    </div>
  )
}

export default function EpisodeDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const id = params.id as string
  const seekParam = searchParams.get('seek')
  const parsedSeek = seekParam != null ? parseFloat(seekParam) : NaN
  const initialSeek = isFinite(parsedSeek) && parsedSeek >= 0 ? parsedSeek : undefined

  const [episode, setEpisode] = useState<Episode | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [complianceFlags, setComplianceFlags] = useState<ComplianceFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [viewLang, setViewLang] = useState<'original' | 'english'>('original')
  const [translating, setTranslating] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{ action: string; message: string } | null>(null)
  const [resolvingFlag, setResolvingFlag] = useState<number | null>(null)
  const [resolveNotes, setResolveNotes] = useState('')
  const [showResolved, setShowResolved] = useState(false)
  const [highlightText, setHighlightText] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Text selection correction toolbar state
  const [selectionToolbar, setSelectionToolbar] = useState<{
    text: string
    position: { top: number; left: number }
  } | null>(null)

  const seekToRef = useRef<SeekToFn | null>(null)

  const fetchEpisode = useCallback(async () => {
    const [epRes, flagsRes] = await Promise.all([
      fetch(`/api/episodes/${id}`),
      fetch(`/api/compliance?episode_id=${id}`),
    ])
    if (epRes.ok) {
      const data = await epRes.json()
      setEpisode(data.episode)
      setTranscript(data.transcript)
      setEditSummary(data.episode.summary ?? '')
      setEditCategory(data.episode.issue_category ?? '')
    }
    if (flagsRes.ok) {
      const data = await flagsRes.json()
      setComplianceFlags(data.flags ?? [])
    }
    setLoading(false)
  }, [id])

  useEffect(() => { fetchEpisode() }, [fetchEpisode])

  async function handleSave() {
    setSaving(true)
    await fetch(`/api/episodes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: editSummary, issue_category: editCategory }),
    })
    await fetchEpisode()
    setSaving(false)
  }

  async function handleAction(action: string) {
    const confirmMessages: Record<string, string> = {
      're-transcribe': 'Re-transcribe this episode? This will overwrite the existing transcript.',
      're-summarize': 'Re-summarize this episode? This will overwrite the existing summary.',
    }
    if (confirmMessages[action]) {
      setConfirmAction({ action, message: confirmMessages[action] })
      return
    }
    executeAction(action)
  }

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Clean up polling on unmount
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  async function executeAction(action: string) {
    setConfirmAction(null)
    setActionLoading(action)

    const res = await fetch(`/api/episodes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setToast(data.error ?? `Action failed: ${res.status}`)
      setActionLoading(null)
      return
    }

    const data = await res.json().catch(() => ({}))

    // For background jobs, poll until status changes
    const bgActions = ['re-transcribe', 're-summarize']
    if (bgActions.includes(action)) {
      const waitingStatus = action === 're-transcribe' ? 'pending' : 'transcribed'
      setToast(data.message ?? `${action} queued — waiting for worker...`)

      let polls = 0
      const maxPolls = 60 // 5 minutes at 5s intervals
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        polls++
        try {
          const epRes = await fetch(`/api/episodes/${id}`)
          if (epRes.ok) {
            const epData = await epRes.json()
            const currentStatus = epData.episode?.status
            if (currentStatus && currentStatus !== waitingStatus) {
              // Job completed (or failed)
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
              setActionLoading(null)
              await fetchEpisode()
              if (currentStatus === 'failed') {
                setToast(`${action} failed: ${epData.episode.error_message ?? 'unknown error'}`)
              } else {
                setToast(`${action} complete`)
              }
            }
          }
        } catch { /* network error, keep polling */ }
        if (polls >= maxPolls) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          setActionLoading(null)
          await fetchEpisode()
          setToast('Still processing — check back shortly')
        }
      }, 5000)
    } else {
      // Immediate actions (retry, fix-dates, etc)
      setToast(data.message ?? 'Done')
      await fetchEpisode()
      setActionLoading(null)
    }
  }

  async function resolveFlag(flagId: number) {
    await fetch('/api/compliance', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: flagId, resolved: true, resolved_notes: resolveNotes }),
    })
    setResolvingFlag(null)
    setResolveNotes('')
    fetchEpisode()
  }

  async function unresolveFlag(flagId: number) {
    await fetch('/api/compliance', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: flagId, resolved: false, resolved_notes: null }),
    })
    fetchEpisode()
  }

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Search VTT captions for excerpt text and return the cue start time, or null */
  function findTimestampFromVtt(excerpt: string): number | null {
    if (!showVtt) return null
    const needle = excerpt.toLowerCase().slice(0, 80)
    const blocks = showVtt.split(/\n\n+/)
    for (const block of blocks) {
      const lines = block.trim().split('\n')
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->/)
        if (match) {
          const text = lines.slice(i + 1).join(' ').toLowerCase()
          if (text.includes(needle)) {
            return +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000
          }
        }
      }
    }
    return null
  }

  function jumpToTimestamp(seconds: number, excerpt?: string | null) {
    if (seekToRef.current) {
      seekToRef.current(seconds)
    }
    if (excerpt) {
      // Clear any previous highlight timer to prevent stacking
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
      setHighlightText(excerpt)
      highlightTimerRef.current = setTimeout(() => setHighlightText(null), 5000)
    }
  }

  function copyFlagDetails(flag: ComplianceFlag) {
    const ts = flag.timestamp_seconds ?? (flag.excerpt ? findTimestampFromVtt(flag.excerpt) : null)
    const lines = [
      `Show: ${episode?.show_name ?? 'Unknown'}`,
      `Date: ${episode?.air_date ?? episode?.date ?? 'Unknown'}`,
      `Time: ${episode?.start_time ? `${episode.start_time}–${episode.end_time ?? ''}` : 'Unknown'}`,
      `MP3: ${episode?.mp3_url ?? 'Unknown'}`,
      ts != null ? `Violation at: ${formatTimestamp(ts)}` : null,
      `Flag: ${FLAG_TYPE_LABELS[flag.flag_type] ?? flag.flag_type} (${flag.severity})`,
      flag.excerpt ? `Quote: "${flag.excerpt}"` : null,
    ].filter(Boolean).join('\n')
    navigator.clipboard.writeText(lines).then(() => setToast('Copied to clipboard'))
  }

  function handleTextSelected(text: string, rect: DOMRect) {
    // rect is viewport-relative; position: fixed is also viewport-relative — no scroll offset needed
    setSelectionToolbar({
      text,
      position: {
        top: rect.bottom + 4,
        left: rect.left,
      },
    })
  }

  function downloadFile(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function handleTranslate() {
    if (transcript?.english_transcript) {
      setViewLang('english')
      return
    }
    setTranslating(true)
    try {
      const res = await fetch(`/api/episodes/${id}/translate`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setTranscript((prev) =>
          prev
            ? { ...prev, english_transcript: data.english_transcript, english_vtt: data.english_vtt }
            : prev
        )
        setViewLang('english')
      } else {
        const data = await res.json().catch(() => ({}))
        setToast(data.error ?? 'Translation failed')
      }
    } catch {
      setToast('Translation request failed')
    } finally {
      setTranslating(false)
    }
  }

  const isNonEnglish = transcript?.language != null && transcript.language !== 'en'
  const showTranscript = viewLang === 'english' && transcript?.english_transcript ? transcript.english_transcript : transcript?.transcript
  const showVtt = viewLang === 'english' && transcript?.english_vtt ? transcript.english_vtt : transcript?.vtt

  if (loading) return (
    <div className="space-y-6">
      <div className="h-8 bg-gray-200 dark:bg-warm-700 rounded w-64 animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-white dark:bg-surface-raised rounded shadow dark:shadow-card-dark p-3 animate-pulse">
            <div className="h-3 bg-gray-200 dark:bg-warm-700 rounded w-16 mb-2" />
            <div className="h-4 bg-gray-200 dark:bg-warm-700 rounded w-24" />
          </div>
        ))}
      </div>
      <SkeletonBlock />
      <SkeletonBlock />
    </div>
  )
  if (!episode) return <p className="text-red-600">Episode not found</p>

  const unresolvedFlags = complianceFlags.filter((f) => !f.resolved)
  const resolvedFlags = complianceFlags.filter((f) => f.resolved)

  // Build metadata grid items — Host and Guest use inline editing
  const metadataItems: { label: string; value: string; editable?: 'host' | 'guest' }[] = [
    { label: 'Air Date', value: episode.air_date ?? episode.date ?? '\u2014' },
    { label: 'Time', value: episode.start_time ? `${episode.start_time} - ${episode.end_time ?? ''}` : '\u2014' },
    { label: 'Duration', value: episode.duration ? `${episode.duration} min` : '\u2014' },
    { label: 'Show Key', value: episode.show_key },
    { label: 'Category', value: episode.category ?? '\u2014' },
    { label: 'Host', value: episode.host ?? '', editable: 'host' },
    { label: 'Guest', value: episode.guest ?? '', editable: 'guest' },
    { label: 'Created', value: new Date(episode.created_at).toLocaleDateString() },
  ]

  return (
    <div className="space-y-6">
      <Breadcrumbs episodeName={episode.show_name ?? `Episode ${episode.id}`} />

      <div className="flex items-center gap-3">
        <a href="/dashboard/episodes" className="text-sm text-gray-500 hover:text-gray-700 dark:text-warm-400 dark:hover:text-warm-200">&larr; Episodes</a>
        <a href={`/dashboard/shows/${encodeURIComponent(episode.show_key)}`} className="text-2xl font-bold hover:text-blue-700 dark:hover:text-blue-400 transition-colors">
          {episode.show_name ?? `Episode ${episode.id}`}
        </a>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[episode.status] ?? 'bg-gray-100 dark:bg-warm-700'}`}>
          {episode.status}
        </span>
      </div>

      {/* Error message */}
      {episode.error_message && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-300">
          <strong>Error:</strong> {episode.error_message}
          {episode.retry_count > 0 && <span className="ml-2">(retries: {episode.retry_count})</span>}
        </div>
      )}

      {/* Discrepancy notes */}
      {episode.compliance_report && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800 dark:bg-amber-900/20 dark:border-amber-800/40 dark:text-amber-300 flex items-start justify-between gap-2">
          <span><strong>Discrepancy:</strong> {episode.compliance_report}</span>
          <button
            onClick={async () => {
              await fetch(`/api/episodes/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ compliance_report: null }),
              })
              fetchEpisode()
            }}
            className="text-amber-600 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-200 shrink-0 text-xs underline"
            title="Dismiss this discrepancy"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Metadata Grid — Host/Guest are inline-editable */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {metadataItems.map((item) => (
          <div key={item.label} className="bg-white dark:bg-surface-raised rounded shadow dark:shadow-card-dark p-3">
            <p className="text-xs text-gray-500 dark:text-warm-400">{item.label}</p>
            {item.editable ? (
              <InlineEditField
                value={item.value}
                field={item.editable}
                episodeId={id}
                onSaved={(newValue) => {
                  setEpisode((prev) => prev ? { ...prev, [item.editable!]: newValue || null } : prev)
                }}
              />
            ) : (
              <p className="text-sm font-medium truncate">{item.value}</p>
            )}
          </div>
        ))}
      </div>

      {/* Action buttons */}
      <div className="flex gap-3 flex-wrap">
        {(episode.status === 'failed' || episode.status === 'unavailable') && (
          <button onClick={() => handleAction('retry')} disabled={actionLoading !== null} className="px-3 py-1.5 text-sm bg-yellow-500 text-white rounded hover:bg-yellow-600 disabled:opacity-50">
            {actionLoading === 'retry' ? 'Retrying...' : 'Retry'}
          </button>
        )}
        <button onClick={() => handleAction('re-transcribe')} disabled={actionLoading !== null} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
          {actionLoading === 're-transcribe' ? (pollRef.current ? 'Transcribing...' : 'Queuing...') : 'Re-Transcribe'}
        </button>
        <button onClick={() => handleAction('re-summarize')} disabled={actionLoading !== null || !transcript?.transcript} className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50">
          {actionLoading === 're-summarize' ? (pollRef.current ? 'Summarizing...' : 'Queuing...') : 'Re-Summarize'}
        </button>
        <button onClick={() => handleAction('fix-dates')} disabled={actionLoading !== null} className="px-3 py-1.5 text-sm bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50">
          {actionLoading === 'fix-dates' ? 'Fixing...' : 'Fix Dates from URL'}
        </button>
        <a href={episode.mp3_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 dark:bg-warm-700 dark:text-warm-200 rounded hover:bg-gray-300 dark:hover:bg-warm-600">
          Download MP3
        </a>
        {transcript?.transcript && (
          <button onClick={() => downloadFile(transcript.transcript!, `episode-${id}.txt`, 'text/plain')} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 dark:bg-warm-700 dark:text-warm-200 rounded hover:bg-gray-300 dark:hover:bg-warm-600">
            Download Transcript
          </button>
        )}
        {transcript?.vtt && (
          <button onClick={() => downloadFile(transcript.vtt!, `episode-${id}.vtt`, 'text/vtt')} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 dark:bg-warm-700 dark:text-warm-200 rounded hover:bg-gray-300 dark:hover:bg-warm-600">
            Download VTT
          </button>
        )}
        {episode.transcript_url && (
          <a href={episode.transcript_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 dark:bg-warm-700 dark:text-warm-200 rounded hover:bg-gray-300 dark:hover:bg-warm-600">
            Legacy Drive Link
          </a>
        )}
      </div>

      {/* Summary & Category Editor */}
      <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-3">
        <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Summary & Category</h3>
        {episode.headline && <p className="font-medium">{episode.headline}</p>}
        <textarea
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          rows={4}
          className="w-full border rounded p-2 text-sm dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
          placeholder="Summary..."
        />
        <div className="flex items-center gap-3">
          <select
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
          >
            <option value="">Select Issue Category</option>
            {issueCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-green-600 dark:bg-green-700 text-white rounded hover:bg-green-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* ═══ Compliance Flags ═══ */}
      {complianceFlags.length > 0 && (
        <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark">
          <div className="px-4 py-3 border-b dark:border-warm-700 flex items-center justify-between">
            <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Compliance Flags</h3>
            <div className="flex items-center gap-2">
              {unresolvedFlags.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 font-medium">{unresolvedFlags.length} unresolved</span>
              )}
              {resolvedFlags.length > 0 && (
                <button
                  onClick={() => setShowResolved(!showResolved)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-400 dark:hover:text-warm-200"
                >
                  {showResolved ? 'Hide' : 'Show'} {resolvedFlags.length} resolved
                </button>
              )}
            </div>
          </div>
          <div className="divide-y dark:divide-warm-700">
            {unresolvedFlags.map((flag) => (
              <div key={flag.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0 mt-0.5 ${SEVERITY_COLORS[flag.severity] ?? SEVERITY_COLORS.warning}`}>
                    {flag.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-warm-100">{FLAG_TYPE_LABELS[flag.flag_type] ?? flag.flag_type}</p>
                    {flag.details && <p className="text-xs text-gray-600 dark:text-warm-400 mt-0.5">{flag.details}</p>}
                    {flag.excerpt && (
                      <button
                        onClick={() => {
                          if (flag.timestamp_seconds != null) {
                            jumpToTimestamp(flag.timestamp_seconds, flag.excerpt)
                          } else {
                            setHighlightText(flag.excerpt!.slice(0, 60))
                          }
                        }}
                        className="text-xs text-gray-500 dark:text-warm-400 mt-1 bg-gray-50 dark:bg-warm-700 hover:bg-blue-50 hover:text-blue-700 dark:hover:bg-blue-900/30 dark:hover:text-blue-300 rounded px-2 py-1 font-mono text-left w-full transition-colors cursor-pointer"
                        title={flag.timestamp_seconds != null ? `Play from ${formatTimestamp(flag.timestamp_seconds)}` : 'Find in transcript'}
                      >
                        &ldquo;...{flag.excerpt}...&rdquo;
                      </button>
                    )}
                    {(() => {
                      const ts = flag.timestamp_seconds ?? (flag.excerpt ? findTimestampFromVtt(flag.excerpt) : null)
                      if (ts !== null) {
                        return (
                          <button
                            onClick={() => jumpToTimestamp(ts, flag.excerpt)}
                            className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-white bg-blue-600 dark:bg-blue-700 rounded hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors"
                            title="Play audio from this timestamp"
                          >
                            <span>&#9654;</span> Listen at {formatTimestamp(ts)}
                          </button>
                        )
                      }
                      if (flag.excerpt) {
                        return (
                          <button
                            onClick={() => setHighlightText(flag.excerpt!.slice(0, 60))}
                            className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
                            title="Find this excerpt in the transcript"
                          >
                            <span>&#128269;</span> Find in transcript
                          </button>
                        )
                      }
                      return null
                    })()}
                    {/* "Not a real word" shortcut for profanity flags */}
                    {flag.flag_type === 'profanity' && flag.excerpt && (
                      <button
                        onClick={(e) => {
                          const rect = (e.target as HTMLElement).getBoundingClientRect()
                          setSelectionToolbar({
                            text: flag.excerpt!,
                            position: { top: rect.bottom + 4, left: rect.left },
                          })
                        }}
                        className="text-[10px] text-gray-400 hover:text-gray-600 dark:text-warm-400 dark:hover:text-warm-200 mt-1"
                      >
                        Not a real word — add correction
                      </button>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-2">
                    <button
                      onClick={() => copyFlagDetails(flag)}
                      className="text-xs px-2 py-1 border rounded hover:bg-gray-50 text-gray-400 hover:text-gray-600"
                      title="Copy flag details to clipboard"
                    >
                      Copy
                    </button>
                    {resolvingFlag === flag.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={resolveNotes}
                          onChange={(e) => setResolveNotes(e.target.value)}
                          placeholder="Notes (optional)"
                          className="border rounded px-2 py-1 text-xs w-48 dark:border-warm-600 dark:bg-warm-800 dark:text-warm-100"
                        />
                        <button onClick={() => resolveFlag(flag.id)} className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700">
                          Resolve
                        </button>
                        <button onClick={() => setResolvingFlag(null)} className="text-xs text-gray-400 hover:text-gray-600 dark:text-warm-400 dark:hover:text-warm-200">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setResolvingFlag(flag.id); setResolveNotes('') }}
                        className="text-xs px-2 py-1 border rounded hover:bg-gray-50 text-gray-500 dark:text-warm-400 dark:border-warm-600 dark:hover:bg-warm-700"
                      >
                        Resolve
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {showResolved && resolvedFlags.map((flag) => (
              <div key={flag.id} className="px-4 py-3 opacity-60">
                <div className="flex items-start gap-3">
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium border bg-gray-100 text-gray-500 border-gray-200 dark:bg-warm-700 dark:text-warm-400 dark:border-warm-600 shrink-0 mt-0.5 line-through">
                    {flag.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-500 dark:text-warm-400 line-through">{FLAG_TYPE_LABELS[flag.flag_type] ?? flag.flag_type}</p>
                    {flag.resolved_notes && <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">Resolved: {flag.resolved_notes}</p>}
                    {flag.resolved_by && <p className="text-[10px] text-gray-400 dark:text-warm-500 mt-0.5">by {flag.resolved_by}</p>}
                  </div>
                  <button
                    onClick={() => unresolveFlag(flag.id)}
                    className="text-[10px] text-gray-400 hover:text-gray-600 dark:text-warm-400 dark:hover:text-warm-200 shrink-0"
                  >
                    Undo
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Language toggle for non-English episodes */}
      {isNonEnglish && transcript?.transcript && (
        <div className="flex items-center gap-3 bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark px-4 py-3">
          <span className="text-xs text-gray-500 dark:text-warm-400 uppercase font-semibold">Language</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 font-medium">
            {transcript.language === 'es' ? 'Spanish' : transcript.language?.toUpperCase()}
          </span>
          <div className="flex rounded-md border dark:border-warm-600 overflow-hidden text-sm">
            <button
              onClick={() => setViewLang('original')}
              className={`px-3 py-1 ${viewLang === 'original' ? 'bg-blue-600 text-white dark:bg-blue-700' : 'bg-white dark:bg-warm-800 text-gray-700 dark:text-warm-300 hover:bg-gray-50 dark:hover:bg-warm-700'}`}
            >
              Original
            </button>
            <button
              onClick={handleTranslate}
              disabled={translating}
              className={`px-3 py-1 ${viewLang === 'english' ? 'bg-blue-600 text-white dark:bg-blue-700' : 'bg-white dark:bg-warm-800 text-gray-700 dark:text-warm-300 hover:bg-gray-50 dark:hover:bg-warm-700'} disabled:opacity-50`}
            >
              {translating ? 'Translating...' : 'English'}
            </button>
          </div>
          {viewLang === 'english' && transcript.english_transcript && (
            <span className="text-[10px] text-gray-400 dark:text-warm-500">AI-translated</span>
          )}
        </div>
      )}

      {/* VTT Audio Player (lazy-loaded) */}
      {showVtt && (
        <AudioPlayerWithCaptions
          mp3Url={episode.mp3_url}
          vtt={showVtt}
          initialSeek={initialSeek}
          onReady={(fn) => { seekToRef.current = fn }}
        />
      )}

      {/* Transcript Viewer (lazy-loaded) */}
      {showTranscript && (
        <TranscriptViewer
          transcript={showTranscript}
          onTextSelected={handleTextSelected}
          highlightText={highlightText}
        />
      )}

      {/* Floating correction toolbar */}
      {selectionToolbar && (
        <CorrectionToolbar
          selectedText={selectionToolbar.text}
          position={selectionToolbar.position}
          episodeId={id}
          onClose={() => setSelectionToolbar(null)}
          onSaved={() => {
            setToast('Correction saved! Re-transcribe to apply.')
          }}
        />
      )}

      {/* Toast notification */}
      {toast && <InlineToast message={toast} onDone={() => setToast(null)} />}

      {/* Confirm dialog */}
      <ConfirmDialog
        open={confirmAction !== null}
        title="Confirm Action"
        message={confirmAction?.message ?? ''}
        confirmLabel="Proceed"
        confirmVariant="danger"
        onConfirm={() => confirmAction && executeAction(confirmAction.action)}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  )
}
