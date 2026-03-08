'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { SkeletonBlock } from '@/app/components/skeleton'

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
  failed: 'bg-red-100 text-red-800',
  unavailable: 'bg-gray-100 text-gray-600',
}

export default function EpisodeDetailPage() {
  const params = useParams()
  const id = params.id as string
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [transcript, setTranscript] = useState<Transcript | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [editSummary, setEditSummary] = useState('')
  const [editCategory, setEditCategory] = useState('')

  const fetchEpisode = useCallback(async () => {
    const res = await fetch(`/api/episodes/${id}`)
    if (res.ok) {
      const data = await res.json()
      setEpisode(data.episode)
      setTranscript(data.transcript)
      setEditSummary(data.episode.summary ?? '')
      setEditCategory(data.episode.issue_category ?? '')
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
    if (confirmMessages[action] && !confirm(confirmMessages[action])) return

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

  return (
    <div className="space-y-6">
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
        {[
          ['Air Date', episode.air_date ?? episode.date ?? '—'],
          ['Time', episode.start_time ? `${episode.start_time} - ${episode.end_time ?? ''}` : '—'],
          ['Duration', episode.duration ? `${episode.duration} min` : '—'],
          ['Show Key', episode.show_key],
          ['Category', episode.category ?? '—'],
          ['Host', episode.host ?? '—'],
          ['Guest', episode.guest ?? '—'],
          ['Created', new Date(episode.created_at).toLocaleDateString()],
        ].map(([label, value]) => (
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

      {/* VTT Audio Player (lazy-loaded) */}
      {transcript?.vtt && (
        <AudioPlayerWithCaptions mp3Url={episode.mp3_url} vtt={transcript.vtt} />
      )}

      {/* Transcript Viewer (lazy-loaded) */}
      {transcript?.transcript && (
        <TranscriptViewer transcript={transcript.transcript} />
      )}
    </div>
  )
}
