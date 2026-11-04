import { describe, it, expect } from 'vitest'
import { wordPattern, restrictedHoursCheck } from './compliance-match'

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

describe('restrictedHoursCheck', () => {
  it('uses the moment the word aired, not the show start', () => {
    const at = restrictedHoursCheck('05:00:00', 120) // 5am–7am block
    expect(at(30 * 60)).toBe(false) // 5:30am — safe harbor
    expect(at(90 * 60)).toBe(true) // 6:30am — restricted
  })
  it('stays restricted when the offset is unknown and any part of the show is restricted', () => {
    expect(restrictedHoursCheck('05:00:00', 120)(null)).toBe(true)
    expect(restrictedHoursCheck('21:00:00', 120)(null)).toBe(true)
  })
  it('is safe harbor for an overnight show entirely inside 10pm–6am', () => {
    expect(restrictedHoursCheck('22:00:00', 120)(null)).toBe(false)
    expect(restrictedHoursCheck('22:00:00', 120)(100 * 60)).toBe(false) // 23:40
    expect(restrictedHoursCheck('00:00:00', 60)(null)).toBe(false)
  })
  it('handles shows that cross midnight and unknown air time', () => {
    expect(restrictedHoursCheck('23:00:00', 120)(90 * 60)).toBe(false) // 00:30
    expect(restrictedHoursCheck(null, 60)(0)).toBe(true)
  })
})
