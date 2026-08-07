import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PITCH_LEXICON,
  analyzeEpisode,
  buildReport,
  buildStationLexicon,
  detectSegments,
  episodeAirtimeMs,
  extractAmounts,
  formatDuration,
  renderSegmentsCsv,
  rollupByAsker,
  rollupByHour,
  rollupByShow,
  scoreCue,
  secToClock,
  timeToSec,
  usualAmount,
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
    host: 'Demo Host',
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

describe('the intent veto (station promos)', () => {
  it('does not count a program promo that names the channel but asks for nothing', () => {
    // Real false positive: a promo for a show, carrying the station URL.
    const timeline = cues(0, [
      'Join us and be a part of the solution, Mondays at 5 a.m. on KPFK 90.7 FM in Los Angeles.',
      'And online for everyone, everywhere, at kpfk.org.',
      'That is California Solartopia, every Monday morning.',
      'Tune in and be part of the conversation on KPFK 90.7 FM.',
      'You can also find us on the web at kpfk.org.',
    ])
    expect(detectSegments(timeline, { lexicon })).toHaveLength(0)
  })

  it('still counts the same channel language once an ask is attached', () => {
    const timeline = cues(0, [
      'Join us and be a part of the solution, Mondays at 5 a.m. on KPFK 90.7 FM.',
      'Make your donation of $100 right now.',
      'Call 818-985-5735, or give online at kpfk.org.',
    ])
    const segments = detectSegments(timeline, { lexicon })
    expect(segments).toHaveLength(1)
    expect(segments[0].ask.completeness).toBe('complete')
  })
})

describe('ask classification', () => {
  it('reads amounts in digits, words and Spanish', () => {
    expect(extractAmounts('a $100 pledge')).toEqual([100])
    expect(extractAmounts('that is 75 dollars')).toEqual([75])
    expect(extractAmounts('un certificado de 75 dólares')).toEqual([75])
    expect(extractAmounts('for seventy-five dollars you get the CD')).toEqual([75])
    expect(extractAmounts('$5, $10 or $25 a month')).toEqual([5, 10, 25])
  })

  it('ignores bare numbers and news-scale money', () => {
    expect(extractAmounts('we are at 60 percent of goal with 20 minutes left')).toEqual([])
    expect(extractAmounts('a $1.8 billion fund')).toEqual([])
    expect(extractAmounts('the $250,000 grant')).toEqual([])
  })

  it("separates the station's own numbers from what the listener is asked for", () => {
    // Real KPFK copy: the goal is not an ask, and neither is the shortfall.
    expect(extractAmounts('our hope and our goal is to raise $200,000 for KPFK')).toEqual([])
    expect(extractAmounts('we are $700 short of our goal for the Tom Hartman Program')).toEqual([])
    expect(
      extractAmounts('We are $700 short of our goal — make that $100 pledge right now.')
    ).toEqual([100])
    // A genuinely expensive premium still reads as an ask.
    expect(extractAmounts('It is a $2,000 tax-deductible charitable contribution')).toEqual([2000])
    // The hour's target, stated either side of the word.
    expect(extractAmounts('We have a $1,000 goal for Tom Hartman, and we only have $300.')).toEqual([300])
    expect(extractAmounts("Now, our goal for today's program is $1,000.")).toEqual([])
  })

  it('reports the level an asker drives to, not the biggest number they said', () => {
    expect(usualAmount([[100, 6], [1000, 1]])).toBe(100)
    // Nothing repeats: the median, not the maximum.
    expect(usualAmount([[50, 1], [100, 1], [1000, 1]])).toBe(100)
    expect(usualAmount([])).toBeNull()
  })

  it('marks completeness from the channels actually named', () => {
    const both = detectSegments(
      cues(0, ['Pledge now: call 818-985-5735 or give online at kpfk.org.']),
      { lexicon }
    )[0]
    expect(both.ask.completeness).toBe('complete')

    const phoneOnly = detectSegments(cues(0, ['Make that pledge now, call 818-985-5735.']), { lexicon })[0]
    expect(phoneOnly.ask.completeness).toBe('partial')
    expect(phoneOnly.ask.phone).toBe(true)
    expect(phoneOnly.ask.web).toBe(false)

    // The interesting case: an ask with nowhere to act on it.
    const orphan = detectSegments(
      cues(0, ['We are asking you to become a sustaining member of this station today.']),
      { lexicon }
    )[0]
    expect(orphan.ask.completeness).toBe('none')
  })

  it('flags sustainer, premium, matching and deadline asks', () => {
    const seg = detectSegments(
      cues(0, [
        'Become a sustainer at $10 every month and we will send you the book as a thank you gift.',
        'Your gift is matched dollar for dollar in the next ten minutes.',
      ]),
      { lexicon }
    )[0]
    expect(seg.ask.sustainer).toBe(true)
    expect(seg.ask.premium).toBe(true)
    expect(seg.ask.matching).toBe(true)
    expect(seg.ask.deadline).toBe(true)
    expect(seg.ask.amounts).toEqual([10])
  })
})

describe('rollupByAsker', () => {
  const pitch = (text: string) => cues(0, [text])

  it('scores each host separately and reports the level they drive to', () => {
    const a = analyzeEpisode(
      episode({ id: 1, host: 'Alice' }),
      pitch('Pledge $100 now, call 818-985-5735 or give online at kpfk.org.'),
      { lexicon }
    )
    const b = analyzeEpisode(
      episode({ id: 2, host: 'Alice' }),
      pitch('Pledge $100 today by calling 818-985-5735.'),
      { lexicon }
    )
    const c = analyzeEpisode(
      episode({ id: 3, host: 'Bob' }),
      pitch('Become a sustainer for $25 a month — pledge now at kpfk.org.'),
      { lexicon }
    )

    const askers = rollupByAsker([a, b, c])
    expect(askers).toHaveLength(2)

    const alice = askers.find((x) => x.host === 'Alice')!
    expect(alice.segmentCount).toBe(2)
    expect(alice.complete).toBe(1)
    expect(alice.partial).toBe(1)
    expect(alice.modalAmount).toBe(100)
    expect(alice.sustainerAsks).toBe(0)

    const bob = askers.find((x) => x.host === 'Bob')!
    expect(bob.sustainerAsks).toBe(1)
    expect(bob.maxAmount).toBe(25)
  })

  it('collapses hosts when asked to', () => {
    const a = analyzeEpisode(episode({ id: 1, host: 'Alice' }), pitch('Pledge now at kpfk.org.'), { lexicon })
    const b = analyzeEpisode(episode({ id: 2, host: 'Bob' }), pitch('Pledge now at kpfk.org.'), { lexicon })
    expect(rollupByAsker([a, b], false)).toHaveLength(1)
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
  it('refuses to measure an episode whose transcript arrived as one giant caption', () => {
    // Real case: a 2-hour show with a single cue spanning 0s → 7205s. Counting
    // that as one 2-hour pitch is worse than reporting it as unmeasured.
    const ep = episode({ durationMin: 120 })
    const giant = [{ startMs: 1000, endMs: 7_205_000, text: 'Pledge now, call 818-985-5735, kpfk.org.' }]
    const r = analyzeEpisode(ep, giant, { lexicon })
    expect(r.hasTranscript).toBe(true)
    expect(r.timedCues).toBe(false)
    expect(r.segments).toHaveLength(0)
  })

  it('splits a segment that straddles the top of the hour', () => {
    const ep = episode({ airStart: '09:00:00', durationMin: 120 })
    const result = analyzeEpisode(ep, [], { lexicon })
    // 59:00 → 61:00 of the show = 30s in hour 09, 90s in hour 10.
    result.segments = [
      {
        startMs: 59 * 60_000,
        endMs: 61 * 60_000,
        durationMs: 120_000,
        tier: 'strong',
        terms: ['pledge'],
        ask: {
          phone: false,
          web: false,
          completeness: 'none',
          amounts: [],
          sustainer: false,
          premium: false,
          matching: false,
          deadline: false,
        },
        excerpt: '',
      },
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
