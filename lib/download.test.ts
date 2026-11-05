import { describe, expect, it } from 'vitest'
import { filenameFromContentDisposition, publicQirPath } from './download'

describe('filenameFromContentDisposition', () => {
  it('reads the quoted form the downloads route emits', () => {
    expect(filenameFromContentDisposition('attachment; filename="episodes_Q3_2026.csv"')).toBe('episodes_Q3_2026.csv')
  })
  it('reads a bare filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=vtts_Q1_2025.txt')).toBe('vtts_Q1_2025.txt')
  })
  it('prefers filename* over filename', () => {
    expect(
      filenameFromContentDisposition(`attachment; filename="fallback.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`)
    ).toBe('résumé.txt')
  })
  it('returns null when missing', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition('inline')).toBeNull()
  })
})

describe('publicQirPath', () => {
  it('is station-qualified', () => {
    expect(publicQirPath('wpfw', 2026, 3)).toBe('/wpfw/2026/q3')
  })
})
