import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PITCH_LEXICON,
  analyzeEpisode,
  buildReport,
  buildStationLexicon,
  detectSegments,
  episodeAirtimeMs,
  formatDuration,
  renderSegmentsCsv,
  rollupByHour,
  rollupByShow,
  scoreCue,
  secToClock,
  timeToSec,
  type PitchCue,
  type PitchEpisode,
} from './pitch-report'

const lexicon = buildStationLexicon('kpfk')

/** Build a cue timeline: one cue every 5s starting at `startSec`. */
function cues(startSec: number, texts: string[]): PitchCue[] {
  return texts.map((text, i) => ({
    startMs: (startSec + i * 5) * 1000,
    endMs: (startSec + i * 5 + 5) * 1000,
    text,
  }))
}

const FILLER = 'And that brings us back to the conversation we were having earlier.'

function episode(overrides: Partial<PitchEpisode> = {}): PitchEpisode {
  return {
    id: 1,
    showKey: 'demo',
    showGroup: 'demo',
    showName: 'Demo Show',
    airDate: '2026-07-31',
    airStart: '09:00:00',
    airEnd: '10:00:00',
    durationMin: 60,
    ...overrides,
  }
}

describe('scoreCue', () => {
  it('tiers an explicit ask as strong', () => {
    const s = scoreCue({ startMs: 0, endMs: 1000, text: 'Call us at 818-985-5735 to pledge.' }, lexicon)
    expect(s.tier).toBe('strong')
    expect(s.terms).toContain('pledge')
  })

  it('treats news money and support language as weak only', () => {
    const s = scoreCue(
      { startMs: 0, endMs: 1000, text: 'The settlement created a $1.8 billion fund for claimants.' },
      lexicon
    )
    expect(s.tier).toBe('weak')
  })

  it('does not fire on Spanish news that merely sounds like an ask', () => {
    // "llamas" (flames) and "llamado" (a call for) are wildfire and UN copy —
    // the Spanish terms are deliberately narrowed to "llame al <number>".
    const s = scoreCue(
      { startMs: 0, endMs: 1000, text: 'La ONU reiteró su llamado a todas las partes, podíamos ver las llamas.' },
      lexicon
    )
    expect(s.score).toBe(0)
  })

  it('fires on an in-language ask', () => {
    const s = scoreCue({ startMs: 0, endMs: 1000, text: 'Llame al 818-985-5735 y haga su donación.' }, lexicon)
    expect(s.tier).toBe('strong')
  })
})

describe('detectSegments', () => {
  it('finds a produced spot shorter than the dust threshold when strongly anchored', () => {
    // Verbatim from a KPFK spot: the ask is the imperative, not the number.
    const timeline = cues(0, [
      FILLER,
      'Support the programming you rely on right now by calling 818-985-5735 or contribute online at kpfk.org.',
      FILLER,
    ])
    const segments = detectSegments(timeline, { lexicon })
    expect(segments).toHaveLength(1)
    expect(segments[0].tier).toBe('strong')
    expect(segments[0].durationMs).toBeLessThan(20_000)
  })

  it("does not count a talk show's own call-in line as a pitch", () => {
    // "Call 202-808-9925" is Thom Hartmann's listener line, read hourly — a real
    // false positive from the first pass over KPFK's archive.
    const timeline = cues(0, [FILLER, 'Call 202-808-9925.', FILLER])
    expect(detectSegments(timeline, { lexicon })).toHaveLength(0)
  })

  it('merges asks separated by chat into one break', () => {
    const timeline = cues(0, [
      'We are in the final stretch of the fund drive.',
      FILLER,
      FILLER,
      FILLER,
      'Make that pledge of $100 right now and we will send you the book.',
    ])
    const segments = detectSegments(timeline, { lexicon })
    expect(segments).toHaveLength(1)
    expect(segments[0].durationMs).toBe(25_000)
  })

  it('splits breaks separated by more than the gap tolerance', () => {
    const timeline = [
      ...cues(0, ['Call 818-985-5735 to pledge now.']),
      ...cues(300, ['Call 818-985-5735 to pledge now.']),
    ]
    const segments = detectSegments(timeline, { lexicon })
    expect(segments).toHaveLength(2)
  })

  it('ignores a news hour full of money and support language', () => {
    const timeline = cues(0, [
      'The bill costs billions of dollars, tens of billions.',
      'Immigrants who have contributed to our communities deserve dignity.',
      'A $1.8 billion fund for anybody claiming political persecution.',
      'Members of the committee voted down the amendment.',
      'Supporters of the measure said they would try again.',
    ])
    expect(detectSegments(timeline, { lexicon })).toHaveLength(0)
  })

  it('does not treat the legal ID as a pitch', () => {
    // The hourly ID names the URL but asks for nothing — the station URL is a
    // medium term for exactly this reason.
    const timeline = cues(0, [
      FILLER,
      "You're listening to KPFK 90.7 FM Los Angeles, and on the web at kpfk.org.",
      FILLER,
    ])
    expect(detectSegments(timeline, { lexicon })).toHaveLength(0)
  })

  it('counts corroborated soft language as a pitch once it runs long enough', () => {
    const soft = [
      'We want to thank everyone who has donated so far today.',
      'Your membership is what keeps this show going.',
      'It is a $75 gift certificate from the restaurant.',
      'You can pick it up when you make the call.',
      'That is seventy five dollars, and the station is the beneficiary.',
      'A few other people have donated as well this hour.',
    ]
    // 6 cues x 5s = 30s of talk with no explicit ask in it.
    expect(detectSegments(cues(0, soft), { lexicon })).toHaveLength(1)
    // A single passing mention in a 15s blip is dust: too short, no strong term,
    // and not dense enough (one medium term scores 2, below minShortScore).
    const passing = cues(0, [FILLER, 'Your membership is what keeps this show going.', FILLER])
    expect(detectSegments(passing, { lexicon })).toHaveLength(0)
  })

  it('honours an operator-supplied extra term', () => {
    const custom = buildStationLexicon('kpfk', ['Summer Drive 2026'])
    const timeline = cues(0, [FILLER, 'This is the Summer Drive 2026 hour.', FILLER])
    expect(detectSegments(timeline, { lexicon: custom })).toHaveLength(1)
    expect(detectSegments(timeline, { lexicon })).toHaveLength(0)
  })

  it('escapes operator-supplied terms rather than treating them as regexes', () => {
    expect(() => buildStationLexicon('kpfk', ['pledge ('])).not.toThrow()
    const custom = buildStationLexicon('kpfk', ['pledge ('])
    expect(detectSegments(cues(0, ['a pledge ( typo']), { lexicon: custom })).toHaveLength(1)
  })
})

describe('airtime', () => {
  it('prefers the logged duration', () => {
    expect(episodeAirtimeMs(episode({ durationMin: 58 }), [])).toBe(58 * 60_000)
  })

  it('falls back to the scheduled span, wrapping past midnight', () => {
    const ep = episode({ durationMin: null, airStart: '22:00:00', airEnd: '00:00:00' })
    expect(episodeAirtimeMs(ep, [])).toBe(2 * 3_600_000)
  })

  it('falls back to the last cue when nothing else is known', () => {
    const ep = episode({ durationMin: null, airStart: null, airEnd: null })
    expect(episodeAirtimeMs(ep, [{ startMs: 0, endMs: 90_000, text: 'x' }])).toBe(90_000)
  })
})

describe('roll-ups', () => {
  it('splits a segment that straddles the top of the hour', () => {
    const ep = episode({ airStart: '09:00:00', durationMin: 120 })
    const result = analyzeEpisode(ep, [], { lexicon })
    // 59:00 → 61:00 of the show = 30s in hour 09, 90s in hour 10.
    result.segments = [
      { startMs: 59 * 60_000, endMs: 61 * 60_000, durationMs: 120_000, tier: 'strong', terms: ['pledge'], excerpt: '' },
    ]
    result.pitchMs = 120_000
    result.segmentCount = 1
    const hours = rollupByHour([result])
    expect(hours.find((h) => h.hour === 9)!.pitchMs).toBe(60_000)
    expect(hours.find((h) => h.hour === 10)!.pitchMs).toBe(60_000)
    // The event is counted once, in the hour it began.
    expect(hours.find((h) => h.hour === 9)!.segmentCount).toBe(1)
    expect(hours.find((h) => h.hour === 10)!.segmentCount).toBe(0)
  })

  it('groups feed keys of one logical show together', () => {
    const a = analyzeEpisode(episode({ id: 1, showKey: 'strip1', showGroup: 'strip' }), [], { lexicon })
    const b = analyzeEpisode(episode({ id: 2, showKey: 'strip2', showGroup: 'strip' }), [], { lexicon })
    expect(rollupByShow([a, b])).toHaveLength(1)
    expect(rollupByShow([a, b])[0].episodes).toBe(2)
  })

  it('reports a transcript-less airing as unmeasured, not as zero pitch', () => {
    const r = analyzeEpisode(episode(), [], { lexicon })
    expect(r.hasTranscript).toBe(false)
    const report = buildReport({ stationSlug: 'kpfk', stationName: 'KPFK', start: 'a', end: 'b' }, [r])
    expect(report.totals.episodes).toBe(1)
    expect(report.totals.episodesWithTranscript).toBe(0)
  })
})

describe('rendering', () => {
  it('puts a clock time on every segment row', () => {
    const ep = episode({ airStart: '15:00:00' })
    const r = analyzeEpisode(ep, cues(0, ['Call 818-985-5735 to pledge now.']), { lexicon })
    const csv = renderSegmentsCsv(
      buildReport({ stationSlug: 'kpfk', stationName: 'KPFK', start: 'a', end: 'b' }, [r])
    )
    expect(csv.split('\n')[1]).toContain('15:00')
  })

  it('quotes excerpts containing commas', () => {
    const ep = episode()
    const r = analyzeEpisode(ep, cues(0, ['Pledge now, and we will send you the book, today.']), { lexicon })
    const csv = renderSegmentsCsv(
      buildReport({ stationSlug: 'kpfk', stationName: 'KPFK', start: 'a', end: 'b' }, [r])
    )
    expect(csv.split('\n')[1]).toMatch(/"Pledge now, and we will send you the book, today\."/)
  })
})

describe('helpers', () => {
  it('parses and formats clock times', () => {
    expect(timeToSec('09:30:00')).toBe(34_200)
    expect(timeToSec(null)).toBeNull()
    expect(timeToSec('nonsense')).toBeNull()
    expect(secToClock(34_200)).toBe('09:30')
    expect(secToClock(90_000)).toBe('01:00') // wraps past midnight
  })

  it('formats durations at the right granularity', () => {
    expect(formatDuration(9_000)).toBe('9s')
    expect(formatDuration(125_000)).toBe('2m 05s')
    expect(formatDuration(3_725_000)).toBe('1h 02m')
  })

  it('ships a lexicon with all three tiers', () => {
    const tiers = new Set(DEFAULT_PITCH_LEXICON.map((t) => t.tier))
    expect(tiers).toEqual(new Set(['strong', 'medium', 'weak']))
  })
})
