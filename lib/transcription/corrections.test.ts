import { describe, it, expect } from 'vitest'
import {
  applyCorrections,
  applyCorrectionsToVtt,
  buildVariantRule,
  correctionMatches,
  correctionsForEpisode,
  isSelfReapplying,
  toPrefilterPattern,
  type Correction,
} from './corrections'

const rule = (over: Partial<Correction>): Correction => ({
  wrong: 'x',
  correct: 'y',
  caseSensitive: false,
  isRegex: false,
  ...over,
})

describe('correctionsForEpisode', () => {
  const groups: Record<string, string> = { biketalka: 'bike talk', biketalk: 'bike talk', risingup: 'risingup' }
  const groupOf = (k: string) => groups[k] ?? k.toLowerCase()
  const rules = [
    rule({ wrong: 'station' }),
    rule({ wrong: 'episode', episodeId: 7 }),
    rule({ wrong: 'show', showKey: 'biketalka' }),
  ]

  it('keeps station-wide rules everywhere', () => {
    expect(correctionsForEpisode(rules, 1, 'risingup', groupOf).map((r) => r.wrong)).toEqual(['station'])
  })
  it('keeps an episode rule only on that episode', () => {
    expect(correctionsForEpisode(rules, 7, 'risingup', groupOf).map((r) => r.wrong)).toEqual(['station', 'episode'])
  })
  it('applies a show rule to every feed of the show group', () => {
    expect(correctionsForEpisode(rules, 2, 'biketalk', groupOf).map((r) => r.wrong)).toEqual(['station', 'show'])
  })
  it('never applies a show rule to an episode with no show', () => {
    expect(correctionsForEpisode(rules, 2, null, groupOf).map((r) => r.wrong)).toEqual(['station'])
  })
  it('falls back to case-insensitive key equality without a group lookup', () => {
    expect(correctionsForEpisode(rules, 2, 'BikeTalkA').map((r) => r.wrong)).toEqual(['station', 'show'])
  })
})

describe('applyCorrections', () => {
  it('escapes plain-text rules and honors case flags', () => {
    expect(applyCorrections('Kay PFK and kay pfk', [rule({ wrong: 'Kay PFK', correct: 'KPFK' })])).toBe('KPFK and KPFK')
    expect(applyCorrections('Kay PFK and kay pfk', [rule({ wrong: 'Kay PFK', correct: 'KPFK', caseSensitive: true })])).toBe('KPFK and kay pfk')
    expect(applyCorrections('a.b axb', [rule({ wrong: 'a.b', correct: 'Z' })])).toBe('Z axb')
  })
  it('skips an invalid regex instead of throwing', () => {
    expect(applyCorrections('abc', [rule({ wrong: '(', isRegex: true })])).toBe('abc')
  })
})

describe('isSelfReapplying', () => {
  it('flags a replacement that the pattern matches again', () => {
    expect(isSelfReapplying(rule({ wrong: 'Cary', correct: 'Cary Harrison' }))).toBe(true)
  })
  it('passes ordinary name fixes', () => {
    expect(isSelfReapplying(rule({ wrong: 'Carrie Harrison', correct: 'Cary Harrison' }))).toBe(false)
    expect(isSelfReapplying(rule({ wrong: '\\b(Negwa|Negua|Nagua)\\b', correct: 'Nagwa', isRegex: true, caseSensitive: true }))).toBe(false)
  })
})

describe('applyCorrectionsToVtt', () => {
  const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Speaker 0>Hi, I\'m Carrie Harrison.\n\n2\n00:00:04.000 --> 00:00:06.000\nCarrie Harrison again\n'
  it('rewrites cue text but not timings, ids or voice tags', () => {
    const out = applyCorrectionsToVtt(vtt, [rule({ wrong: 'Carrie Harrison', correct: 'Cary Harrison' })])
    expect(out).toContain("<v Speaker 0>Hi, I'm Cary Harrison.")
    expect(out).toContain('Cary Harrison again')
    expect(out).toContain('00:00:01.000 --> 00:00:04.000')
    expect(out.startsWith('WEBVTT')).toBe(true)
  })
  it('never touches a timing line even when a rule would match it', () => {
    const out = applyCorrectionsToVtt(vtt, [rule({ wrong: '00', correct: 'XX' })])
    expect(out).toContain('00:00:01.000 --> 00:00:04.000')
  })
  it('never rewrites a speaker label', () => {
    const out = applyCorrectionsToVtt(vtt, [rule({ wrong: 'Speaker', correct: 'Host' })])
    expect(out).toContain('<v Speaker 0>')
  })
})

describe('toPrefilterPattern', () => {
  it('translates JS word boundaries to Postgres \\y', () => {
    expect(toPrefilterPattern(rule({ wrong: '\\b(Esty|Esti)\\b', isRegex: true }))).toBe('\\y(Esty|Esti)\\y')
  })
  it('escapes plain text', () => {
    expect(toPrefilterPattern(rule({ wrong: 'Dr. Who?' }))).toBe('Dr\\. Who\\?')
  })
  it('gives up on JS-only syntax', () => {
    expect(toPrefilterPattern(rule({ wrong: '(?<=Mr )Smith', isRegex: true }))).toBeNull()
    expect(toPrefilterPattern(rule({ wrong: '\\p{L}+', isRegex: true }))).toBeNull()
  })
})

describe('buildVariantRule', () => {
  it('builds a whole-word, case-insensitive rule tolerant of extra spaces', () => {
    const r = buildVariantRule('Nick Richard', 'Nick Richert')
    expect(r).toEqual({ wrong: '\\bNick\\s+Richard\\b', correct: 'Nick Richert', caseSensitive: false, isRegex: true })
    expect(applyCorrections('nick  richard said; Nick Richards left', [r])).toBe('Nick Richert said; Nick Richards left')
  })
  it('does not anchor on a non-ASCII end letter (JS \\b is ASCII-only)', () => {
    const r = buildVariantRule('Renèe Yaworskí', 'Renee Yaworski')
    expect(correctionMatches('with Renèe Yaworskí today', r)).toBe(true)
  })
})
