import { describe, it, expect } from 'vitest'
import {
  normalizeWords, fingerprint, containment, bestMatch, airedEarlier, findDisclosures, rerunFlagFields,
  RERUN_THRESHOLD, MIN_FINGERPRINT, type PriorAiring,
} from './rerun'

// Deterministic pseudo-speech: N words drawn from a vocabulary by seed, so two
// "episodes" with different seeds share words but almost no 4-word runs.
function speech(seed: number, n: number): string {
  const vocab = 'the people city water housing police school we they said what because about right now there union rent council budget county'.split(' ')
  let x = seed
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    out.push(vocab[(x >>> 16) % vocab.length]) // high bits: an LCG's low bits cycle fast
  }
  return out.join(' ')
}

// A "re-transcription": same speech, a few words misheard, different casing/punctuation.
function retranscribe(text: string, everyNth: number): string {
  return text
    .split(' ')
    .map((w, i) => (i % everyNth === 0 ? 'uh' : i % 7 === 0 ? `${w[0].toUpperCase()}${w.slice(1)},` : w))
    .join(' ')
}

const prior = (id: number, text: string, air_date = '2026-10-01', air_start = '12:00:00'): PriorAiring => ({
  id, air_date, air_start, fingerprint: fingerprint(text),
})

describe('normalizeWords', () => {
  it('folds case, accents and punctuation', () => {
    expect(normalizeWords('Médico, MÉDICO! médico')).toEqual(['medico', 'medico', 'medico'])
  })
})

describe('fingerprint + containment', () => {
  const a = speech(1, 9000)

  it('is sorted, de-duplicated, and big enough for an hour of talk', () => {
    const fp = fingerprint(a)
    expect(fp.length).toBeGreaterThan(MIN_FINGERPRINT)
    expect([...fp].sort((x, y) => x - y)).toEqual(fp)
    expect(new Set(fp).size).toBe(fp.length)
  })

  it('scores a re-transcription of the same audio above the threshold', () => {
    // 1 word in 40 misheard ≈ 10% of 4-word shingles disturbed.
    expect(containment(fingerprint(retranscribe(a, 40)), fingerprint(a))).toBeGreaterThan(RERUN_THRESHOLD)
  })

  it('scores a different episode near zero', () => {
    expect(containment(fingerprint(speech(2, 9000)), fingerprint(a))).toBeLessThan(0.1)
  })

  it('measures containment of the NEW episode: a trimmed rerun still matches', () => {
    const trimmed = a.split(' ').slice(1000, 8000).join(' ')
    expect(containment(fingerprint(trimmed), fingerprint(a))).toBeGreaterThan(0.95)
  })

  it('half old, half new falls below the threshold', () => {
    const half = `${a.split(' ').slice(0, 4500).join(' ')} ${speech(3, 4500)}`
    expect(containment(fingerprint(half), fingerprint(a))).toBeLessThan(RERUN_THRESHOLD)
  })
})

describe('bestMatch', () => {
  const a = speech(10, 9000)
  it('picks the matching prior and ignores the rest', () => {
    const m = bestMatch(fingerprint(retranscribe(a, 50)), [prior(1, speech(11, 9000)), prior(2, a), prior(3, speech(12, 9000))])
    expect(m?.prior.id).toBe(2)
  })
  it('returns null under the threshold', () => {
    expect(bestMatch(fingerprint(a), [prior(1, speech(11, 9000))])).toBeNull()
  })
  it('ignores tiny transcripts (a near-empty music hour matches anything)', () => {
    const tiny = speech(5, 100)
    expect(bestMatch(fingerprint(tiny), [prior(1, tiny)])).toBeNull()
  })
})

describe('airedEarlier', () => {
  const ep = { air_date: '2026-11-05', air_start: '16:00:00' }
  it('earlier day counts', () => expect(airedEarlier(ep, { air_date: '2026-10-29', air_start: '16:00:00' })).toBe(true))
  it('same day, earlier slot counts (DN 7am → 4pm)', () => expect(airedEarlier(ep, { air_date: '2026-11-05', air_start: '07:00:00' })).toBe(true))
  it('the same airing on another feed does not', () => expect(airedEarlier(ep, { air_date: '2026-11-05', air_start: '15:59:00' })).toBe(false))
  it('later airings do not', () => expect(airedEarlier(ep, { air_date: '2026-11-06', air_start: '07:00:00' })).toBe(false))
  it('unknown start on the same day does not', () => expect(airedEarlier(ep, { air_date: '2026-11-05', air_start: null })).toBe(false))
})

describe('findDisclosures', () => {
  it('finds an announcement added for the rerun (live Sojourner Truth wording)', () => {
    const rerun = "kpfk.org. The program that you're about to hear is a rebroadcast and has previously aired here on KPFK. Welcome to"
    const d = findDisclosures(rerun, 'kpfk.org. Welcome to')
    expect(d.map((x) => x.phrase.toLowerCase())).toEqual(['rebroadcast', 'has previously aired'])
  })
  it('ignores a phrase the original also said (not an added announcement)', () => {
    const line = 'this interview was originally recorded in 1968 at the Ash Grove'
    expect(findDisclosures(`intro ${line}`, `other intro ${line.toUpperCase()}`)).toEqual([])
  })
  it('finds Spanish announcements', () => {
    expect(findDisclosures('Esta es una retransmisión del programa', '').length).toBeGreaterThan(0)
    expect(findDisclosures('programa transmitido originalmente el lunes', '').length).toBeGreaterThan(0)
  })
  it('does not treat ordinary speech as a disclosure', () => {
    expect(findDisclosures('es como una repetición pero por qué; le ciel n’est pas encore clair; best of luck', '')).toEqual([])
  })
})

describe('rerunFlagFields', () => {
  const match = { score: 0.932, prior: { ...prior(9963, 'x', '2026-10-18', '12:00:00'), show_name: 'Ralph Nader Radio Hour' } }
  it('undisclosed on an earlier day is a warning', () => {
    const f = rerunFlagFields({ air_date: '2026-10-25' }, match, 'text', [])
    expect(f.severity).toBe('warning')
    expect(f.excerpt).toBeNull()
    expect(f.details).toBe('Undisclosed rerun: 93% of this transcript matches Ralph Nader Radio Hour aired 2026-10-18 12:00 (episode #9963), and no rerun announcement was found.')
  })
  it('same-day repeat is info', () => {
    expect(rerunFlagFields({ air_date: '2026-10-18' }, match, 'text', []).severity).toBe('info')
  })
  it('disclosed is info and quotes the announcement', () => {
    const t = 'hello. The program you are about to hear is a rebroadcast of last week. Welcome'
    const f = rerunFlagFields({ air_date: '2026-10-25' }, match, t, findDisclosures(t, ''))
    expect(f.severity).toBe('info')
    expect(f.excerpt).toContain('rebroadcast')
    expect(f.disclosureText).toBe('rebroadcast')
  })
})
