'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'

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

interface VttCue {
  start: number
  end: number
  text: string
}

function parseVtt(vtt: string): VttCue[] {
  const cues: VttCue[] = []
  const blocks = vtt.split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.trim().split('\n')
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/)
      if (match) {
        const start = +match[1] * 3600 + +match[2] * 60 + +match[3] + +match[4] / 1000
        const end = +match[5] * 3600 + +match[6] * 60 + +match[7] + +match[8] / 1000
        const text = lines.slice(i + 1).join(' ').trim()
        if (text) cues.push({ start, end, text })
      }
    }
  }
  return cues
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
  const [searchQuery, setSearchQuery] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const activeCueRef = useRef<HTMLDivElement>(null)

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

  if (loading) return <p className="text-gray-500">Loading...</p>
  if (!episode) return <p className="text-red-600">Episode not found</p>

  const vttCues = transcript?.vtt ? parseVtt(transcript.vtt) : []
  const activeCueIdx = vttCues.findIndex((c) => currentTime >= c.start && currentTime < c.end)

  const transcriptText = transcript?.transcript ?? ''
  const highlightedTranscript = searchQuery
    ? transcriptText.replace(
        new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
        '<mark class="bg-yellow-200">$1</mark>'
      )
    : transcriptText

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

      {/* VTT Audio Player */}
      {transcript?.vtt && (
        <div className="bg-white rounded-lg shadow p-4 space-y-3">
          <h3 className="font-semibold text-sm text-gray-500 uppercase">Audio Player with Captions</h3>
          <audio
            ref={audioRef}
            src={episode.mp3_url}
            controls
            className="w-full"
            onTimeUpdate={() => {
              if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
            }}
          />
          <div className="max-h-48 overflow-y-auto border rounded p-2 text-sm space-y-1">
            {vttCues.map((cue, i) => (
              <div
                key={i}
                ref={i === activeCueIdx ? activeCueRef : undefined}
                className={`px-2 py-1 rounded cursor-pointer ${
                  i === activeCueIdx ? 'bg-blue-100 text-blue-900 font-medium' : 'hover:bg-gray-100'
                }`}
                onClick={() => {
                  if (audioRef.current) {
                    audioRef.current.currentTime = cue.start
                    audioRef.current.play()
                  }
                }}
              >
                <span className="text-xs text-gray-400 mr-2">
                  {Math.floor(cue.start / 60)}:{String(Math.floor(cue.start % 60)).padStart(2, '0')}
                </span>
                {cue.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Transcript Viewer */}
      {transcript?.transcript && (
        <div className="bg-white rounded-lg shadow p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-sm text-gray-500 uppercase">Transcript</h3>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search transcript..."
              className="border rounded px-2 py-1 text-sm w-64"
            />
          </div>
          <div
            className="max-h-96 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap"
            dangerouslySetInnerHTML={{ __html: highlightedTranscript }}
          />
        </div>
      )}
    </div>
  )
}
