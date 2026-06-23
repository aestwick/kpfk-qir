// Build a WebVTT caption file from normalized transcription segments.
//
// When a segment carries a speaker label (diarized providers), it is emitted as
// a standard WebVTT voice span — `<v Speaker 0>text` — so caption players show
// the speaker. lib/vtt.ts#parseVtt strips these tags when extracting cue text,
// keeping transcript-search cues clean.

import type { NormalizedSegment } from './types'

interface Correction {
  wrong: string
  correct: string
  caseSensitive: boolean
  isRegex: boolean
}

export function applyCorrections(text: string, corrections: Correction[]): string {
  let result = text
  for (const c of corrections) {
    const flags = c.caseSensitive ? 'g' : 'gi'
    if (c.isRegex) {
      try {
        result = result.replace(new RegExp(c.wrong, flags), c.correct)
      } catch (err) {
        console.warn(
          `[transcribe] Skipping invalid regex correction "${c.wrong}":`,
          err instanceof Error ? err.message : err,
        )
      }
    } else {
      const escaped = c.wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      result = result.replace(new RegExp(escaped, flags), c.correct)
    }
  }
  return result
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
function pad3(n: number): string {
  return n.toString().padStart(3, '0')
}

export function formatVttTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.floor((safe % 1) * 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad3(ms)}`
}

// Escape the few characters that are special inside VTT cue text so a stray
// "<" in the transcript can't be read as a tag.
function escapeCueText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Build a WEBVTT string from absolute-timed segments. Corrections are applied to
 * each cue's text. When `withSpeakers` is true and a segment has a speaker label,
 * the cue text is wrapped in a `<v ...>` voice span.
 */
export function buildVtt(
  segments: NormalizedSegment[],
  corrections: Correction[],
  withSpeakers: boolean,
): string {
  let vtt = 'WEBVTT\n\n'
  let cueIndex = 1
  for (const seg of segments) {
    const corrected = applyCorrections(seg.text.trim(), corrections)
    if (!corrected) continue
    const escaped = escapeCueText(corrected)
    const body =
      withSpeakers && seg.speaker ? `<v ${escapeCueText(seg.speaker)}>${escaped}` : escaped
    vtt += `${cueIndex}\n${formatVttTime(seg.startSec)} --> ${formatVttTime(seg.endSec)}\n${body}\n\n`
    cueIndex++
  }
  return vtt
}

/** Join segment texts into a clean, speaker-free transcript (feeds summarization). */
export function buildPlainText(segments: NormalizedSegment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
}
