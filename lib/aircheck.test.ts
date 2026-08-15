import { describe, it, expect } from 'vitest'
import {
  DEFAULT_AIRCHECK_CONFIG,
  buildIdMatcher,
  datesInRange,
  detectPromos,
  enumerateBoundaries,
  hasSignoff,
  normalizeText,
  scanEpisodeEdges,
  scanStreamNight,
  secToClock,
  startsMidSentence,
  streamOf,
  cityFromStationName,
  timeToSec,
  type AircheckConfig,
  type AircheckEpisode,
  type Cue,
} from './aircheck'

const cfg: AircheckConfig = {
  ...DEFAULT_AIRCHECK_CONFIG,
  idPatterns: ['kpfk', '90.7', 'ninety point seven', 'noventa punto siete'],
  cityNames: ['los angeles'],
}

function cue(startSec: number, endSec: number, text: string): Cue {
  return { startMs: startSec * 1000, endMs: endSec * 1000, text }
}

describe('normalizeText', () => {
  it('folds accents so Spanish matches unaccented patterns', () => {
    expect(normalizeText('Informativo Pacífica')).toBe('informativo pacifica')
    expect(normalizeText('¿Qué pasa en Los Ángeles?')).toBe('que pasa en los angeles')
  })

  it('strips punctuation so spelled-out call signs collapse to letters', () => {
    expect(normalizeText('K.P.F.K.')).toBe('k p f k')
    expect(normalizeText('K-P-F-K')).toBe('k p f k')
  })
})

describe('buildIdMatcher', () => {
  const m = buildIdMatcher(cfg)

  it('rates call sign + city as a full legal ID', () => {
    expect(m.strength('You are listening to KPFK 90.7 FM, Los Angeles.')).toBe('legal')
  })

  it('rates a bare call sign below a legal ID', () => {
    expect(m.strength('You are rocking with KPFK.')).toBe('callsign')
  })

  it('rates a frequency with no call sign as weakest', () => {
    expect(m.strength('You are listening to 90.7 FM.')).toBe('frequency')
  })

  it('finds nothing when the station is never named', () => {
    expect(m.strength('Welcome back to the show, we have a great guest.')).toBe('none')
  })

  it('matches call letters Whisper spelled out with punctuation', () => {
    expect(m.strength('This is K.P.F.K. in Los Angeles')).toBe('legal')
  })

  it('matches the Spanish spoken frequency the configured patterns miss', () => {
    expect(m.strength('Estás escuchando noventa punto siete')).toBe('frequency')
  })

  it('does not mistake a sister station for this one', () => {
    expect(m.strength('Our colleagues at KPFA in Berkeley reported')).toBe('none')
  })

  it('quotes surrounding context as evidence', () => {
    expect(m.evidence('You are listening to KPFK 90.7 FM')).toContain('kpfk')
  })
})

describe('detectPromos', () => {
  it('finds English tune-in promotion', () => {
    const hits = detectPromos([cue(10, 15, 'Coming up next, stay tuned for more.')])
    expect(hits).toHaveLength(1)
    expect(hits[0].kind).toBe('tune_in')
  })

  it('finds Spanish tune-in promotion', () => {
    const hits = detectPromos([cue(0, 5, 'A continuación, Informativo Pacífica. No te la pierdas.')])
    expect(hits[0].kind).toBe('tune_in')
  })

  it('finds membership and underwriting language', () => {
    expect(detectPromos([cue(0, 5, 'Become a member today.')])[0].kind).toBe('membership')
    expect(detectPromos([cue(0, 5, 'Hazte miembro de tu radio.')])[0].kind).toBe('membership')
    expect(detectPromos([cue(0, 5, 'More information at example.com')])[0].kind).toBe('underwriting')
  })

  it('counts a cue once even when several patterns fire', () => {
    const hits = detectPromos([cue(0, 5, 'Tune in and become a member at kpfk.org')])
    expect(hits).toHaveLength(1)
  })

  it('ignores ordinary programme talk', () => {
    expect(detectPromos([cue(0, 5, 'The city council voted on the housing measure.')])).toHaveLength(0)
  })
})

describe('hasSignoff', () => {
  it('recognises English sign-offs', () => {
    expect(hasSignoff("That's all for tonight, thanks for listening.")).toBe(true)
    expect(hasSignoff('Until next week.')).toBe(true)
  })

  it('recognises Spanish sign-offs', () => {
    expect(hasSignoff('Y así llegamos al final de otra edición del Informativo Pacífica.')).toBe(true)
    expect(hasSignoff('Se despide Norma Martínez.')).toBe(true)
  })

  it('does not fire on ordinary talk', () => {
    expect(hasSignoff('We will talk about housing policy after the break.')).toBe(false)
  })
})

describe('startsMidSentence', () => {
  it('flags a lowercase opening word', () => {
    expect(startsMidSentence(' de habitantes. Se prevé que esta fuerza')).toBe(true)
  })

  it('flags a capitalized but continuing conjunction', () => {
    expect(startsMidSentence('And then the council voted.')).toBe(true)
  })

  it('accepts a clean opening', () => {
    expect(startsMidSentence('Welcome to the East Side Story Show.')).toBe(false)
    expect(startsMidSentence('Muy buenas noches, bienvenidos a Nuestra Voz.')).toBe(false)
  })
})

describe('enumerateBoundaries', () => {
  it('includes the opening mark when the file starts on the hour', () => {
    const b = enumerateBoundaries(timeToSec('20:00:00'), timeToSec('21:00:00'), true)
    expect(b.map((x) => secToClock(x.atSec))).toEqual(['20:00', '20:30'])
  })

  it('classifies top and bottom of the hour', () => {
    const b = enumerateBoundaries(timeToSec('20:00:00'), timeToSec('21:00:00'), true)
    expect(b.map((x) => x.kind)).toEqual(['top', 'bottom'])
  })

  it('omits the half-hour marks when bottom checking is off', () => {
    const b = enumerateBoundaries(timeToSec('20:00:00'), timeToSec('22:00:00'), false)
    expect(b.map((x) => secToClock(x.atSec))).toEqual(['20:00', '21:00'])
  })

  it('excludes the closing mark so it is not scored twice', () => {
    const b = enumerateBoundaries(timeToSec('20:00:00'), timeToSec('20:30:00'), true)
    expect(b.map((x) => secToClock(x.atSec))).toEqual(['20:00'])
  })

  it('handles a file that starts off the boundary', () => {
    const b = enumerateBoundaries(timeToSec('20:01:00'), timeToSec('20:29:00'), true)
    expect(b).toHaveLength(0)
  })
})

describe('scanEpisodeEdges', () => {
  const ep: AircheckEpisode = {
    episodeId: 1, showKey: 'x', showName: 'X', category: null,
    airDate: '2026-08-14', airStart: '20:00:00', durationMin: 30, stream: 'main',
  }

  it('flags a late start', () => {
    const edges = scanEpisodeEdges(ep, [cue(90, 95, 'Good evening and welcome.')], 1800, cfg)
    expect(edges.map((e) => e.issue)).toContain('head_dead_air')
  })

  it('flags a cold open mid-sentence', () => {
    const edges = scanEpisodeEdges(ep, [cue(0, 5, 'de habitantes, se prevé que')], 1800, cfg)
    expect(edges.map((e) => e.issue)).toContain('cold_open')
  })

  it('flags the previous show bleeding past the boundary', () => {
    const edges = scanEpisodeEdges(
      ep,
      [cue(5, 20, 'Y así llegamos al final de otra edición. Se despide Norma Martínez.')],
      1800,
      cfg
    )
    expect(edges.map((e) => e.issue)).toContain('prior_show_bleed')
  })

  it('flags a hard cut when speech runs into the file end with no sign-off', () => {
    const edges = scanEpisodeEdges(ep, [cue(0, 5, 'Welcome in.'), cue(1790, 1800, 'and the other thing is')], 1800, cfg)
    expect(edges.map((e) => e.issue)).toContain('hard_cut')
  })

  it('flags dead air at the tail', () => {
    const edges = scanEpisodeEdges(ep, [cue(0, 5, 'Welcome in.'), cue(1600, 1610, 'more talk here')], 1800, cfg)
    expect(edges.map((e) => e.issue)).toContain('tail_dead_air')
  })

  it('stays quiet on a clean file that signs off', () => {
    const edges = scanEpisodeEdges(
      ep,
      [cue(2, 8, 'Welcome to the programme.'), cue(1700, 1795, 'Thanks for listening, until next week.')],
      1800,
      cfg
    )
    expect(edges).toEqual([])
  })

  it('returns nothing when there are no cues to judge', () => {
    expect(scanEpisodeEdges(ep, [], 1800, cfg)).toEqual([])
  })

  it('skips the tail checks when the slot length was inferred from the captions', () => {
    // durationSec derived from where the captions stop makes the tail gap zero
    // by construction — hard_cut would fire on every such file.
    const cues = [cue(0, 5, 'Welcome in.'), cue(1600, 1700, 'and the other thing is')]
    expect(scanEpisodeEdges(ep, cues, 1700, cfg, false).map((e) => e.issue)).not.toContain('hard_cut')
    expect(scanEpisodeEdges(ep, cues, 1700, cfg, false).map((e) => e.issue)).not.toContain('tail_dead_air')
  })

  it('still reports head issues when the slot length is unknown', () => {
    const edges = scanEpisodeEdges(ep, [cue(90, 95, 'de habitantes, se prevé')], 95, cfg, false)
    expect(edges.map((e) => e.issue)).toEqual(expect.arrayContaining(['head_dead_air', 'cold_open']))
  })
})

describe('scanStreamNight', () => {
  const mk = (id: number, key: string, start: string, mins: number): AircheckEpisode => ({
    episodeId: id, showKey: key, showName: key, category: null,
    airDate: '2026-08-14', airStart: start, durationMin: mins, stream: 'main',
  })

  it('credits an ID given by the outgoing host just before the boundary', () => {
    const a = mk(1, 'early', '20:00:00', 30)
    const b = mk(2, 'late', '20:30:00', 30)
    const cues = new Map<number, Cue[]>([
      // 20:29:30 — inside file A, 30s before file B's opening boundary.
      [1, [cue(1770, 1780, 'You are listening to KPFK 90.7 FM Los Angeles.')]],
      [2, [cue(5, 10, 'Welcome to the show.')]],
    ])
    const scan = scanStreamNight('2026-08-14', 'main', [a, b], cues, cfg)
    const bottom = scan.boundaries.find((x) => secToClock(x.atSec) === '20:30')
    expect(bottom?.strength).toBe('legal')
    expect(bottom?.episodeId).toBe(2) // owned by the incoming file
    expect(bottom?.coveredByNeighbor).toBe(true) // but satisfied by the outgoing one
  })

  it('reports a boundary with no ID anywhere in the window', () => {
    const a = mk(1, 'show', '21:00:00', 60)
    const cues = new Map<number, Cue[]>([[1, [cue(10, 20, 'Welcome back to the programme.')]]])
    const scan = scanStreamNight('2026-08-14', 'main', [a], cues, cfg)
    expect(scan.boundaries.find((x) => secToClock(x.atSec) === '21:00')?.strength).toBe('none')
  })

  it('marks a boundary with no captions at all as uncovered', () => {
    const a = mk(1, 'show', '21:00:00', 60)
    const cues = new Map<number, Cue[]>([[1, [cue(2000, 2010, 'talking here')]]])
    const scan = scanStreamNight('2026-08-14', 'main', [a], cues, cfg)
    expect(scan.boundaries.find((x) => secToClock(x.atSec) === '21:00')?.noCoverage).toBe(true)
  })

  it('attributes a mark to the file that contains it', () => {
    const a = mk(1, 'long', '21:00:00', 120)
    const cues = new Map<number, Cue[]>([[1, [cue(10, 20, 'Hello there.')]]])
    const scan = scanStreamNight('2026-08-14', 'main', [a], cues, cfg)
    expect(scan.boundaries.map((b) => b.showKey)).toEqual(['long', 'long', 'long', 'long'])
  })

  it('skips files with no air_start rather than misplacing them', () => {
    const a = { ...mk(1, 'show', '21:00:00', 60), airStart: null }
    const scan = scanStreamNight('2026-08-14', 'main', [a], new Map(), cfg)
    expect(scan.episodes).toEqual([])
    expect(scan.boundaries).toEqual([])
  })

  it('falls back to caption length when duration is missing', () => {
    const a = { ...mk(1, 'show', '20:00:00', 60), durationMin: null }
    const cues = new Map<number, Cue[]>([[1, [cue(0, 5, 'Hi.'), cue(3500, 3550, 'More.')]]])
    const scan = scanStreamNight('2026-08-14', 'main', [a], cues, cfg)
    expect(scan.boundaries.map((b) => secToClock(b.atSec))).toEqual(['20:00', '20:30'])
  })
})

describe('streamOf', () => {
  it('reads an unnumbered prefix as the main signal', () => {
    expect(streamOf('https://archive.kpfk.org/mp3/kpfk_260813_200000infopac.mp3', 'kpfk')).toBe('main')
  })

  it('separates the numbered second channel', () => {
    expect(streamOf('https://archive.kpfk.org/mp3/2kpfk_260813_200100informap.mp3', 'kpfk')).toBe('stream 2')
  })

  it('does not fold an unrecognised filename into the main signal', () => {
    expect(streamOf('https://example.org/mp3/something_else.mp3', 'kpfk')).toBe('other')
  })

  it('treats a prefix with regex metacharacters literally', () => {
    expect(streamOf('https://x/a.b_260813.mp3', 'a.b')).toBe('main')
    expect(streamOf('https://x/axb_260813.mp3', 'a.b')).toBe('other')
  })

  it('defaults to main when there is nothing to go on', () => {
    expect(streamOf(null, 'kpfk')).toBe('main')
    expect(streamOf('https://x/kpfk_1.mp3', null)).toBe('main')
  })
})

describe('cityFromStationName', () => {
  it('takes the community of license after the comma', () => {
    expect(cityFromStationName('KPFK, Los Angeles')).toEqual(['Los Angeles'])
    expect(cityFromStationName('WPFW, Washington D.C.')).toEqual(['Washington D.C.'])
  })

  it('returns nothing when the name carries no city', () => {
    expect(cityFromStationName('KPFK')).toEqual([])
  })
})

describe('datesInRange', () => {
  it('is inclusive of both ends', () => {
    expect(datesInRange('2026-08-12', '2026-08-14')).toEqual(['2026-08-12', '2026-08-13', '2026-08-14'])
  })

  it('handles a single day', () => {
    expect(datesInRange('2026-08-12', '2026-08-12')).toEqual(['2026-08-12'])
  })
})
