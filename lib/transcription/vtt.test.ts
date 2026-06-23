import { describe, it, expect } from 'vitest'
import { buildVtt, buildPlainText, formatVttTime } from './vtt'
import { parseVtt } from '../vtt'
import type { NormalizedSegment } from './types'

const SEGMENTS: NormalizedSegment[] = [
  { startSec: 0, endSec: 4, text: 'Welcome to the show.', speaker: 'Speaker 0' },
  { startSec: 4, endSec: 9.5, text: 'Thanks for having me.', speaker: 'Speaker 1' },
]

describe('buildVtt', () => {
  it('emits WebVTT voice spans when withSpeakers is true and a speaker is set', () => {
    const vtt = buildVtt(SEGMENTS, [], true)
    expect(vtt).toContain('<v Speaker 0>Welcome to the show.')
    expect(vtt).toContain('<v Speaker 1>Thanks for having me.')
    expect(vtt.startsWith('WEBVTT')).toBe(true)
    expect(vtt).toContain('00:00:00.000 --> 00:00:04.000')
  })

  it('omits voice spans when withSpeakers is false', () => {
    const vtt = buildVtt(SEGMENTS, [], false)
    expect(vtt).not.toContain('<v ')
    expect(vtt).toContain('Welcome to the show.')
  })

  it('applies corrections to cue text', () => {
    const vtt = buildVtt(
      [{ startSec: 0, endSec: 1, text: 'KPFK is great' }],
      [{ wrong: 'KPFK', correct: 'KPFA', caseSensitive: false, isRegex: false }],
      false,
    )
    expect(vtt).toContain('KPFA is great')
  })

  it('escapes stray angle brackets in transcript text', () => {
    const vtt = buildVtt([{ startSec: 0, endSec: 1, text: 'a < b > c' }], [], false)
    expect(vtt).toContain('a &lt; b &gt; c')
  })

  it('round-trips through parseVtt with speaker tags stripped from cue text', () => {
    const vtt = buildVtt(SEGMENTS, [], true)
    const cues = parseVtt(vtt)
    expect(cues).toHaveLength(2)
    // Search cues must hold spoken text only — never the "<v Speaker N>" label.
    expect(cues[0].text).toBe('Welcome to the show.')
    expect(cues[1].text).toBe('Thanks for having me.')
  })
})

describe('buildPlainText', () => {
  it('joins segment texts speaker-free for summarization', () => {
    expect(buildPlainText(SEGMENTS)).toBe('Welcome to the show. Thanks for having me.')
  })
})

describe('formatVttTime', () => {
  it('formats seconds as HH:MM:SS.mmm and clamps negatives to zero', () => {
    expect(formatVttTime(0)).toBe('00:00:00.000')
    expect(formatVttTime(3661.5)).toBe('01:01:01.500')
    expect(formatVttTime(-5)).toBe('00:00:00.000')
  })
})
