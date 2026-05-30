import { describe, it, expect } from 'vitest'
import { parseVtt, normalizeForMatch, findCueForPhrase } from './vtt'

// Mirrors the WEBVTT shape our transcribe worker emits (buildVtt): a numeric cue
// id line, a timing line, then one or more text lines, blocks blank-separated.
const SAMPLE_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:04.000
Welcome to Uprising, today we look at the

2
00:00:04.000 --> 00:00:08.500
latest measles outbreak data from the county.

3
00:00:08.500 --> 00:00:12.250
Vaccination rates remain a concern, officials said.
`

describe('parseVtt', () => {
  it('parses cues with timing, text, and 1-based indexes', () => {
    const cues = parseVtt(SAMPLE_VTT)
    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({
      index: 1,
      startMs: 0,
      endMs: 4000,
      text: 'Welcome to Uprising, today we look at the',
    })
    expect(cues[1].startMs).toBe(4000)
    expect(cues[1].endMs).toBe(8500)
    expect(cues[2].startMs).toBe(8500)
  })

  it('skips the WEBVTT header and blocks without a timing line', () => {
    const cues = parseVtt('WEBVTT\n\nNOTE just a note\n\n')
    expect(cues).toHaveLength(0)
  })

  it('tolerates SRT-style comma milliseconds and CRLF line endings', () => {
    const cues = parseVtt('WEBVTT\r\n\r\n1\r\n00:00:01,500 --> 00:00:02,750\r\nHi there\r\n')
    expect(cues).toHaveLength(1)
    expect(cues[0].startMs).toBe(1500)
    expect(cues[0].endMs).toBe(2750)
  })

  it('returns [] for empty/nullish input', () => {
    expect(parseVtt('')).toEqual([])
    expect(parseVtt(null)).toEqual([])
    expect(parseVtt(undefined)).toEqual([])
  })
})

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeForMatch('  Measles, OUTBREAK!  ')).toBe('measles outbreak')
  })

  it('keeps accented (Spanish) letters', () => {
    expect(normalizeForMatch('Inmigración hoy')).toBe('inmigración hoy')
  })
})

describe('findCueForPhrase', () => {
  const cues = parseVtt(SAMPLE_VTT)

  // (b) common-word match must resolve to the right cue, not mis-hit.
  it('finds a single-cue match and returns its starting cue', () => {
    const cue = findCueForPhrase(cues, 'measles outbreak')
    expect(cue?.index).toBe(2)
    expect(cue?.startMs).toBe(4000)
  })

  it('matches case- and punctuation-insensitively', () => {
    const cue = findCueForPhrase(cues, 'MEASLES, outbreak')
    expect(cue?.index).toBe(2)
  })

  // (a) a phrase spanning two cues resolves to the cue where it begins.
  it('resolves a phrase split across consecutive cues to its start cue', () => {
    const cue = findCueForPhrase(cues, 'look at the latest measles')
    expect(cue?.index).toBe(1)
    expect(cue?.startMs).toBe(0)
  })

  // (c) a no-match returns null — never a guessed cue/time.
  it('returns null when the phrase is absent', () => {
    expect(findCueForPhrase(cues, 'climate change tariffs')).toBeNull()
  })

  it('returns null for an empty phrase', () => {
    expect(findCueForPhrase(cues, '   ')).toBeNull()
  })
})
