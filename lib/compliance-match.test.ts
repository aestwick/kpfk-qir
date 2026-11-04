import { describe, it, expect } from 'vitest'
import { wordPattern } from './compliance-match'

const hits = (word: string, text: string) => wordPattern(word).test(text)

describe('wordPattern', () => {
  it('does not match inside words that contain accented letters', () => {
    expect(hits('culo', 'lo metieron en un vehículo')).toBe(false)
    expect(hits('culo', 'según el artículo 5')).toBe(false)
    expect(hits('culo', 'un espectáculo')).toBe(false)
  })
  it('still matches the standalone word, any case, next to punctuation', () => {
    expect(hits('culo', 'mueve el culo.')).toBe(true)
    expect(hits('shit', 'Holy SHIT!')).toBe(true)
    expect(hits('puta', '"Puta" dijo')).toBe(true)
  })
  it('matches accented list words as whole words', () => {
    expect(hits('cabrón', 'este viaje está cabrón solo')).toBe(true)
    expect(hits('cabrón', 'cabrones')).toBe(false)
  })
  it('handles multi-word entries', () => {
    expect(hits('blow job', 'a blow job')).toBe(true)
  })
  it('does not match ASCII substrings', () => {
    expect(hits('cum', 'summa cum laude')).toBe(true) // known list limitation, judged by reviewer/AI
    expect(hits('cum', 'document')).toBe(false)
    expect(hits('tits', 'titsworth')).toBe(false)
  })
})
