'use client'

import { useRef, useState, useEffect, useCallback } from 'react'

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

export type SeekToFn = (seconds: number) => void

/* ─── Audio Player with VTT Captions ─── */
export function AudioPlayerWithCaptions({
  mp3Url,
  vtt,
  initialSeek,
  onReady,
}: {
  mp3Url: string
  vtt: string
  initialSeek?: number
  onReady?: (seekTo: SeekToFn) => void
}) {
  const [currentTime, setCurrentTime] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)
  const audioRef = useRef<HTMLAudioElement>(null)
  const activeCueRef = useRef<HTMLDivElement>(null)
  const captionsRef = useRef<HTMLDivElement>(null)
  const didInitialSeek = useRef(false)
  const didRegister = useRef(false)

  const vttCues = parseVtt(vtt)
  const activeCueIdx = vttCues.findIndex((c) => currentTime >= c.start && currentTime < c.end)

  const seekTo = useCallback((seconds: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds
      audioRef.current.play()
    }
    // Update state immediately so captions highlight without waiting for onTimeUpdate
    setCurrentTime(seconds)
  }, [])

  // Register seekTo callback with parent (replaces forwardRef which doesn't work through next/dynamic)
  useEffect(() => {
    if (onReady && !didRegister.current) {
      didRegister.current = true
      onReady(seekTo)
    }
  }, [onReady, seekTo])

  // Handle initial seek from URL param
  useEffect(() => {
    if (initialSeek == null || !isFinite(initialSeek) || initialSeek < 0) return
    if (didInitialSeek.current || !audioRef.current) return
    const handleCanPlay = () => {
      if (!didInitialSeek.current && audioRef.current) {
        didInitialSeek.current = true
        audioRef.current.currentTime = initialSeek
      }
    }
    const audio = audioRef.current
    if (audio.readyState >= 2) {
      handleCanPlay()
    } else {
      audio.addEventListener('canplay', handleCanPlay, { once: true })
      return () => audio.removeEventListener('canplay', handleCanPlay)
    }
  }, [initialSeek])

  // Auto-scroll captions to active cue
  useEffect(() => {
    if (autoScroll && activeCueRef.current && captionsRef.current) {
      activeCueRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [activeCueIdx, autoScroll])

  return (
    <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Audio Player with Captions</h3>
        <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-warm-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="rounded"
          />
          Auto-scroll
        </label>
      </div>
      <audio
        ref={audioRef}
        src={mp3Url}
        controls
        className="w-full"
        onTimeUpdate={() => {
          if (audioRef.current) setCurrentTime(audioRef.current.currentTime)
        }}
      />
      <div ref={captionsRef} className="max-h-48 overflow-y-auto border dark:border-warm-600 rounded p-2 text-sm space-y-1">
        {vttCues.map((cue, i) => (
          <div
            key={i}
            ref={i === activeCueIdx ? activeCueRef : undefined}
            className={`px-2 py-1 rounded cursor-pointer ${
              i === activeCueIdx ? 'bg-blue-100 text-blue-900 font-medium dark:bg-blue-900/30 dark:text-blue-200' : 'hover:bg-gray-100 dark:hover:bg-warm-700/50'
            }`}
            onClick={() => seekTo(cue.start)}
          >
            <span className="text-xs text-gray-400 dark:text-warm-500 mr-2">
              {Math.floor(cue.start / 60)}:{String(Math.floor(cue.start % 60)).padStart(2, '0')}
            </span>
            {cue.text}
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─── Transcript Viewer with Search and Text Selection ─── */
export function TranscriptViewer({
  transcript,
  onTextSelected,
  highlightText,
}: {
  transcript: string
  onTextSelected?: (text: string, rect: DOMRect) => void
  highlightText?: string | null
}) {
  const [searchQuery, setSearchQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const onTextSelectedRef = useRef(onTextSelected)
  onTextSelectedRef.current = onTextSelected

  // Handle text selection for "Add Correction" toolbar
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    function handleMouseUp() {
      if (!onTextSelectedRef.current) return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.toString().trim()) return
      // Only trigger if selection is within the transcript container
      if (!container!.contains(selection.anchorNode)) return
      const range = selection.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      onTextSelectedRef.current(selection.toString().trim(), rect)
    }

    container.addEventListener('mouseup', handleMouseUp)
    return () => container.removeEventListener('mouseup', handleMouseUp)
  }, []) // Stable — uses ref for callback

  // Scroll to highlighted text when it changes
  useEffect(() => {
    if (highlightText && containerRef.current) {
      const mark = containerRef.current.querySelector('[data-highlight="true"]')
      if (mark) mark.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlightText])

  function renderTranscript() {
    // Combine search highlight and compliance highlight
    const query = searchQuery || highlightText
    if (!query) return <span>{transcript}</span>
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // Use capturing group split — odd indexes are matches, even indexes are non-matches
    const parts = transcript.split(new RegExp(`(${escaped})`, 'gi'))
    const testRegex = new RegExp(`^${escaped}$`, 'i') // No g flag — avoids stateful lastIndex bug
    let firstHighlight = true
    return (
      <>
        {parts.map((part, i) => {
          if (testRegex.test(part)) {
            const isFirst = firstHighlight
            firstHighlight = false
            return (
              <mark
                key={i}
                className={searchQuery ? 'bg-yellow-200 dark:bg-yellow-700/50 dark:text-yellow-100' : 'bg-amber-200 ring-2 ring-amber-300 dark:bg-amber-800/40 dark:ring-amber-600 dark:text-amber-100'}
                data-highlight={isFirst && highlightText ? 'true' : undefined}
              >
                {part}
              </mark>
            )
          }
          return <span key={i}>{part}</span>
        })}
      </>
    )
  }

  return (
    <div className="bg-white dark:bg-surface-raised rounded-lg shadow dark:shadow-card-dark p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm text-gray-500 dark:text-warm-400 uppercase">Transcript</h3>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search transcript..."
          className="border dark:border-warm-600 rounded px-2 py-1 text-sm w-64 dark:bg-warm-800 dark:text-warm-100 dark:placeholder-warm-500"
        />
      </div>
      <div ref={containerRef} className="max-h-96 overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap">
        {renderTranscript()}
      </div>
    </div>
  )
}
