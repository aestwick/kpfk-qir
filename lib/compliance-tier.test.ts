import { describe, it, expect } from 'vitest'
import { tierOf, flagTerm, isHighRisk, airedMinute, termSpan } from './compliance-tier'

const base = { excerpt: null, duration: 60, timestamp_seconds: 600 }

describe('flagTerm', () => {
  it('reads the word a word-list flag was raised for', () => {
    expect(flagTerm('"shit" detected during FCC restricted hours (6am-10pm)')).toBe('shit')
    expect(flagTerm('The segment sounds like sponsored content')).toBeNull()
    expect(flagTerm(null)).toBeNull()
  })
})

describe('isHighRisk', () => {
  it('catches the high-risk words and their forms', () => {
    for (const w of ['fuck', 'fucking', 'motherfuckers', 'bullshit', 'shit', 'tits']) expect(isHighRisk(w), w).toBe(true)
  })
  it('leaves other listed words for the glance tier', () => {
    for (const w of ['bitch', 'puta', 'culo', 'slut', 'damn', 'petits', 'constitution']) expect(isHighRisk(w), w).toBe(false)
  })
  it('reads an excerpt when there is no term', () => {
    expect(isHighRisk('and then he said f*** this, holy shit')).toBe(true)
  })
})

describe('tierOf', () => {
  it('puts a daytime high-risk word in A', () => {
    expect(tierOf({ ...base, flag_type: 'profanity', details: '"fuck" detected during FCC restricted hours (6am-10pm)', air_start: '14:00' })).toBe('A')
  })
  it('puts a daytime milder word in B', () => {
    expect(tierOf({ ...base, flag_type: 'profanity', details: '"bitch" detected during FCC restricted hours (6am-10pm)', air_start: '07:00' })).toBe('B')
  })
  it('judges safe harbor by when the word aired, not the show start', () => {
    // 9:30pm show, word 40 minutes in = 10:10pm -> safe harbor.
    expect(tierOf({ ...base, flag_type: 'profanity', details: '"fuck" detected', air_start: '21:30', timestamp_seconds: 2400 })).toBe('C')
    // Same show, word 10 minutes in = 9:40pm -> restricted.
    expect(tierOf({ ...base, flag_type: 'profanity', details: '"fuck" detected', air_start: '21:30', timestamp_seconds: 600 })).toBe('A')
  })
  it('treats any daytime indecency as listen-now', () => {
    expect(tierOf({ ...base, flag_type: 'indecency', details: 'Graphic sexual description', air_start: '12:00' })).toBe('A')
  })
  it('sends non-language checks to D', () => {
    for (const t of ['sponsor_id', 'payola_plugola', 'technical', 'station_id_missing']) {
      expect(tierOf({ ...base, flag_type: t, details: null, air_start: '12:00' }), t).toBe('D')
    }
  })
})

describe('airedMinute / termSpan', () => {
  it('adds the offset to the start and wraps past midnight', () => {
    expect(airedMinute('21:30:00', 2400)).toBe(22 * 60 + 10)
    expect(airedMinute('23:50', 1200)).toBe(10)
    expect(airedMinute(null, 10)).toBeNull()
  })
  it('finds the whole word to highlight', () => {
    expect(termSpan('a motherfucking day, fuck it', 'fuck')).toEqual([21, 25])
    expect(termSpan('nothing here', 'fuck')).toBeNull()
  })
})
