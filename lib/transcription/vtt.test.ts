import { describe, it, expect } from 'vitest'
import { buildVtt, buildPlainText, formatVttTime, applyCorrections, correctionsForEpisode } from './vtt'
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

describe('correctionsForEpisode', () => {
  const stationWide = { wrong: 'Kerry', correct: 'Cary', caseSensitive: false, isRegex: false }
  const scopedTo6655 = {
    wrong: 'D',
    correct: 'B',
    caseSensitive: false,
    isRegex: true,
    episodeId: 6655,
  }

  it('keeps station-wide rules and rules scoped to the given episode', () => {
    expect(correctionsForEpisode([stationWide, scopedTo6655], 6655)).toEqual([
      stationWide,
      scopedTo6655,
    ])
  })

  it('drops rules scoped to a DIFFERENT episode', () => {
    // Regression: an episode-scoped single-letter rule (D→B) leaked onto every
    // episode and corrupted hundreds of transcripts ("anB", "TuesBay", ...).
    expect(correctionsForEpisode([stationWide, scopedTo6655], 7000)).toEqual([stationWide])
  })

  it('treats a null episodeId as station-wide', () => {
    const nullScoped = { ...stationWide, episodeId: null }
    expect(correctionsForEpisode([nullScoped], 123)).toEqual([nullScoped])
  })
})

describe('applyCorrections', () => {
  it('a scoped-out rule never reaches the text', () => {
    const rules = correctionsForEpisode(
      [{ wrong: 'D', correct: 'B', caseSensitive: false, isRegex: true, episodeId: 6655 }],
      7000,
    )
    expect(applyCorrections('It is Tuesday evening.', rules)).toBe('It is Tuesday evening.')
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
