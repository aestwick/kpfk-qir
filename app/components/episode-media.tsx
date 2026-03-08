'use client'

import { useRef, useState } from 'react'

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

/* ─── Audio Player with VTT Captions ─── */
export function AudioPlayerWithCaptions({ mp3Url, vtt }: { mp3Url: string; vtt: string }) {
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const activeCueRef = useRef<HTMLDivElement>(null)

  const vttCues = parseVtt(vtt)
  const activeCueIdx = vttCues.findIndex((c) => currentTime >= c.start && currentTime < c.end)

  return (
    <div className="bg-white rounded-lg shadow p-4 space-y-3">
      <h3 className="font-semibold text-sm text-gray-500 uppercase">Audio Player with Captions</h3>
      <audio
        ref={audioRef}
        src={mp3Url}
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
  )
}

/* ─── Transcript Viewer with Search ─── */
export function TranscriptViewer({ transcript }: { transcript: string }) {
  const [searchQuery, setSearchQuery] = useState('')

  function renderTranscript() {
    if (!searchQuery) return <span>{transcript}</span>
    const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`(${escaped})`, 'gi')
    const parts = transcript.split(regex)
    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <mark key={i} className="bg-yellow-200">{part}</mark>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    )
  }

  return (
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
      <div className="max-h-96 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
        {renderTranscript()}
      </div>
    </div>
  )
}
