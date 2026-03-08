'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { ConfirmDialog } from '@/app/components/confirm-dialog'

/* ─── lazy-loaded media components ─── */
const AudioPlayerWithCaptions = dynamic(() => import('@/app/components/episode-media').then(m => ({ default: m.AudioPlayerWithCaptions })), {
  loading: () => <div className="bg-white rounded-lg shadow p-4"><div className="h-32 bg-gray-100 rounded animate-pulse" /></div>,
  ssr: false,
})
const TranscriptViewer = dynamic(() => import('@/app/components/episode-media').then(m => ({ default: m.TranscriptViewer })), {
  loading: () => <div className="bg-white rounded-lg shadow p-4"><div className="h-48 bg-gray-100 rounded animate-pulse" /></div>,
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
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-amber-100 text-amber-800 border-amber-200',
  info: 'bg-blue-100 text-blue-800 border-blue-200',
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
  pending: 'bg-yellow-100 text-yellow-800',
  transcribed: 'bg-blue-100 text-blue-800',
  summarized: 'bg-green-100 text-green-800',
  compliance_checked: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

export default function EpisodeDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [complianceFlags, setComplianceFlags] = useState<ComplianceFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [editCategory, setEditCategory] = useState('')
  const [confirmAction, setConfirmAction] = useState<{ action: string; message: string } | null>(null)
  const [resolvingFlag, setResolvingFlag] = useState<number | null>(null)
  const [resolveNotes, setResolveNotes] = useState('')
  const [showResolved, setShowResolved] = useState(false)

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

  async function executeAction(action: string) {
    setConfirmAction(null)
    setActionLoading(action)
    await fetch(`/api/episodes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
    setTimeout(() => {
      fetchEpisode()
      setActionLoading(null)
    }, 1500)
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

  function downloadFile(content: string, filename: string, mime: string) {
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div className="space-y-6">
      <div className="h-8 bg-gray-200 rounded w-64 animate-pulse" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="bg-white rounded shadow p-3 animate-pulse">
            <div className="h-3 bg-gray-200 rounded w-16 mb-2" />
            <div className="h-4 bg-gray-200 rounded w-24" />
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

  return (
    <div className="space-y-6">
      <Breadcrumbs episodeName={episode.show_name ?? `Episode ${episode.id}`} />

      <div className="flex items-center gap-3">
        <a href="/dashboard/episodes" className="text-sm text-gray-500 hover:text-gray-700">&larr; Episodes</a>
        <h2 className="text-2xl font-bold">{episode.show_name ?? `Episode ${episode.id}`}</h2>
        <span className={`text-xs px-2 py-0.5 rounded-full ${statusColors[episode.status] ?? 'bg-gray-100'}`}>
          {episode.status}
        </span>
      </div>

      {/* Error message */}
      {episode.error_message && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          <strong>Error:</strong> {episode.error_message}
          {episode.retry_count > 0 && <span className="ml-2">(retries: {episode.retry_count})</span>}
        </div>
      )}

      {/* Discrepancy notes */}
      {episode.compliance_report && (
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-sm text-amber-800">
          <strong>Discrepancy:</strong> {episode.compliance_report}
        </div>
      )}

      {/* Metadata Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {([
          ['Air Date', episode.air_date ?? episode.date ?? '\u2014'],
          ['Time', episode.start_time ? `${episode.start_time} - ${episode.end_time ?? ''}` : '\u2014'],
          ['Duration', episode.duration ? `${episode.duration} min` : '\u2014'],
          ['Show Key', episode.show_key],
          ['Category', episode.category ?? '\u2014'],
          ['Host', episode.host ?? '\u2014'],
          ['Guest', episode.guest ?? '\u2014'],
          ['Created', new Date(episode.created_at).toLocaleDateString()],
        ] as [string, string][]).map(([label, value]) => (
          <div key={label} className="bg-white rounded shadow p-3">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-sm font-medium truncate">{value}</p>
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
          {actionLoading === 're-transcribe' ? 'Queuing...' : 'Re-Transcribe'}
        </button>
        <button onClick={() => handleAction('re-summarize')} disabled={actionLoading !== null || !transcript?.transcript} className="px-3 py-1.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-50">
          {actionLoading === 're-summarize' ? 'Queuing...' : 'Re-Summarize'}
        </button>
        <a href={episode.mp3_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
          Download MP3
        </a>
        {transcript?.transcript && (
          <button onClick={() => downloadFile(transcript.transcript!, `episode-${id}.txt`, 'text/plain')} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
            Download Transcript
          </button>
        )}
        {transcript?.vtt && (
          <button onClick={() => downloadFile(transcript.vtt!, `episode-${id}.vtt`, 'text/vtt')} className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
            Download VTT
          </button>
        )}
        {episode.transcript_url && (
          <a href={episode.transcript_url} target="_blank" rel="noopener noreferrer" className="px-3 py-1.5 text-sm bg-gray-200 text-gray-700 rounded hover:bg-gray-300">
            Legacy Drive Link
          </a>
        )}
      </div>

      {/* Summary & Category Editor */}
      <div className="bg-white rounded-lg shadow p-4 space-y-3">
        <h3 className="font-semibold text-sm text-gray-500 uppercase">Summary & Category</h3>
        {episode.headline && <p className="font-medium">{episode.headline}</p>}
        <textarea
          value={editSummary}
          onChange={(e) => setEditSummary(e.target.value)}
          rows={4}
          className="w-full border rounded p-2 text-sm"
          placeholder="Summary..."
        />
        <div className="flex items-center gap-3">
          <select
            value={editCategory}
            onChange={(e) => setEditCategory(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm"
          >
            <option value="">Select Issue Category</option>
            {issueCategories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* ═══ Compliance Flags ═══ */}
      {complianceFlags.length > 0 && (
        <div className="bg-white rounded-lg shadow">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <h3 className="font-semibold text-sm text-gray-500 uppercase">Compliance Flags</h3>
            <div className="flex items-center gap-2">
              {unresolvedFlags.length > 0 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">{unresolvedFlags.length} unresolved</span>
              )}
              {resolvedFlags.length > 0 && (
                <button
                  onClick={() => setShowResolved(!showResolved)}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  {showResolved ? 'Hide' : 'Show'} {resolvedFlags.length} resolved
                </button>
              )}
            </div>
          </div>
          <div className="divide-y">
            {unresolvedFlags.map((flag) => (
              <div key={flag.id} className="px-4 py-3">
                <div className="flex items-start gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0 mt-0.5 ${SEVERITY_COLORS[flag.severity] ?? SEVERITY_COLORS.warning}`}>
                    {flag.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{FLAG_TYPE_LABELS[flag.flag_type] ?? flag.flag_type}</p>
                    {flag.details && <p className="text-xs text-gray-600 mt-0.5">{flag.details}</p>}
                    {flag.excerpt && (
                      <p className="text-xs text-gray-500 mt-1 bg-gray-50 rounded px-2 py-1 font-mono">
                        &ldquo;...{flag.excerpt}...&rdquo;
                      </p>
                    )}
                    {flag.timestamp_seconds !== null && (
                      <p className="text-[10px] text-gray-400 mt-1">
                        At {Math.floor(flag.timestamp_seconds / 3600)}:{String(Math.floor((flag.timestamp_seconds % 3600) / 60)).padStart(2, '0')}:{String(flag.timestamp_seconds % 60).padStart(2, '0')}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0">
                    {resolvingFlag === flag.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={resolveNotes}
                          onChange={(e) => setResolveNotes(e.target.value)}
                          placeholder="Notes (optional)"
                          className="border rounded px-2 py-1 text-xs w-48"
                        />
                        <button onClick={() => resolveFlag(flag.id)} className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700">
                          Resolve
                        </button>
                        <button onClick={() => setResolvingFlag(null)} className="text-xs text-gray-400 hover:text-gray-600">
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setResolvingFlag(flag.id); setResolveNotes('') }}
                        className="text-xs px-2 py-1 border rounded hover:bg-gray-50 text-gray-500"
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
                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium border bg-gray-100 text-gray-500 border-gray-200 shrink-0 mt-0.5 line-through">
                    {flag.severity}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-500 line-through">{FLAG_TYPE_LABELS[flag.flag_type] ?? flag.flag_type}</p>
                    {flag.resolved_notes && <p className="text-xs text-emerald-600 mt-0.5">Resolved: {flag.resolved_notes}</p>}
                    {flag.resolved_by && <p className="text-[10px] text-gray-400 mt-0.5">by {flag.resolved_by}</p>}
                  </div>
                  <button
                    onClick={() => unresolveFlag(flag.id)}
                    className="text-[10px] text-gray-400 hover:text-gray-600 shrink-0"
                  >
                    Undo
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* VTT Audio Player (lazy-loaded) */}
      {transcript?.vtt && (
        <AudioPlayerWithCaptions mp3Url={episode.mp3_url} vtt={transcript.vtt} />
      )}

      {/* Transcript Viewer (lazy-loaded) */}
      {transcript?.transcript && (
        <TranscriptViewer transcript={transcript.transcript} />
      )}

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
