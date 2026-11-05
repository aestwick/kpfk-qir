import { describe, it, expect } from 'vitest'
import { accuracy, countPhrase, lostWords, scoreNames } from './benchmark'

describe('countPhrase', () => {
  it('counts whole-word, case-insensitive, accent-aware', () => {
    expect(countPhrase('Cary Harrison and cary  harrison, not Carrie Harrison', 'Cary Harrison')).toBe(2)
    expect(countPhrase('Gudiño and Gudiñoz', 'Gudiño')).toBe(1)
  })
})

describe('scoreNames / accuracy', () => {
  it('scores right vs known-wrong spellings', () => {
    const s = scoreNames('Carrie Harrison here. Cary Harrison there. Kerry Harrison.', [
      { name: 'Cary Harrison', variants: ['Carrie Harrison', 'Kerry Harrison'] },
    ])
    expect(s).toEqual([{ name: 'Cary Harrison', right: 1, wrong: 2 }])
    expect(accuracy(s)).toBeCloseTo(1 / 3)
    expect(accuracy([{ name: 'x', right: 0, wrong: 0 }])).toBeNull()
  })
})

describe('lostWords', () => {
  const base = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  it('ignores a one-word spelling fix', () => {
    expect(lostWords(base, base.replace('word5', 'fixed'))).toBe(0)
  })
  it('counts a long stretch of replaced speech', () => {
    const replaced = base.split(' ').map((w, i) => (i >= 10 && i < 30 ? 'garbage' : w)).join(' ')
    expect(lostWords(base, replaced)).toBe(20)
  })
  it('is zero for identical text', () => {
    expect(lostWords(base, base)).toBe(0)
  })
})
