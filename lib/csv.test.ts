import { describe, it, expect } from 'vitest'
import { csvField, toCsv } from './csv'

describe('csvField', () => {
  it('leaves plain values bare', () => {
    expect(csvField('Democracy Now')).toBe('Democracy Now')
    expect(csvField(60)).toBe('60')
    expect(csvField(null)).toBe('')
  })
  it('quotes commas, quotes, LF and bare CR', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
    expect(csvField('line1\rline2')).toBe('"line1\rline2"')
  })
  it('defuses formula injection but not plain numbers', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('-5')).toBe('-5')
    expect(csvField('- a dash-led summary')).toBe("'- a dash-led summary")
  })
})

describe('toCsv', () => {
  it('prepends a UTF-8 BOM and uses CRLF rows', () => {
    const out = toCsv(['Host', 'Guest'], [['Peña', 'Cabrón, Jr.']])
    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out.slice(1)).toBe('Host,Guest\r\nPeña,"Cabrón, Jr."')
  })
})
