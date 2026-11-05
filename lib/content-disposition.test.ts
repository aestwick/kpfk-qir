import { describe, it, expect } from 'vitest'
import { filenameFromContentDisposition } from './content-disposition'

describe('filenameFromContentDisposition', () => {
  it('reads a quoted filename (what /api/downloads sends)', () => {
    expect(filenameFromContentDisposition('attachment; filename="episodes_Q3_2026.csv"', 'x')).toBe('episodes_Q3_2026.csv')
  })
  it('reads a bare filename', () => {
    expect(filenameFromContentDisposition('attachment; filename=vtts_Q1_2026.txt', 'x')).toBe('vtts_Q1_2026.txt')
  })
  it('prefers filename* (RFC 5987) over filename', () => {
    expect(
      filenameFromContentDisposition(`attachment; filename="fallback.txt"; filename*=UTF-8''Programaci%C3%B3n.txt`, 'x'),
    ).toBe('Programación.txt')
  })
  it('falls back when the header is missing or has no name', () => {
    expect(filenameFromContentDisposition(null, 'fb.txt')).toBe('fb.txt')
    expect(filenameFromContentDisposition('attachment', 'fb.txt')).toBe('fb.txt')
    expect(filenameFromContentDisposition('attachment; filename=""', 'fb.txt')).toBe('fb.txt')
  })
  it('never yields a path', () => {
    expect(filenameFromContentDisposition('attachment; filename="../../etc/passwd"', 'x')).toBe('.._.._etc_passwd')
  })
})
