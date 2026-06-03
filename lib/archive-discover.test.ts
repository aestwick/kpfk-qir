import { describe, it, expect } from 'vitest'
import { decodeEntities, parseProgramOptions, selectNewShows } from './archive-discover'

describe('decodeEntities', () => {
  it('decodes Spanish punctuation and accents', () => {
    expect(decodeEntities('&iquest;Que Pasa?')).toBe('¿Que Pasa?')
    expect(decodeEntities('Informaci&oacute;n')).toBe('Información')
    expect(decodeEntities('Ma&ntilde;ana')).toBe('Mañana')
  })

  it('decodes numeric (decimal and hex) entities', () => {
    expect(decodeEntities('caf&#233;')).toBe('café')
    expect(decodeEntities('caf&#xE9;')).toBe('café')
  })

  it('decodes the XML basics', () => {
    expect(decodeEntities('Rock &amp; Roll')).toBe('Rock & Roll')
  })

  it('leaves unmapped entities verbatim rather than dropping them', () => {
    expect(decodeEntities('A &fake; B')).toBe('A &fake; B')
  })
})

describe('parseProgramOptions', () => {
  // Real option strings sampled from the four station home pages.
  const sample = `
    <select id="programlist">
    <option value="iquestpasaenlosangele" style="color:#000000;background-color:#FFE2BD;" >&iquest;Que Pasa En Los Angeles?
    <option value="alterradioar" style="color:#000000;background-color:#CABFE0;" >Alternative Radio
    <option value="biketalka" style="color:#000000;background-color:#E5D9FF;" >Bike Talk
    <option value="biketalk" style="color:#000000;background-color:#E5D9FF;" >Bike Talk Podcast
    </select>`

  it('extracts key + decoded name for each option', () => {
    expect(parseProgramOptions(sample)).toEqual([
      { key: 'iquestpasaenlosangele', name: '¿Que Pasa En Los Angeles?' },
      { key: 'alterradioar', name: 'Alternative Radio' },
      { key: 'biketalka', name: 'Bike Talk' },
      { key: 'biketalk', name: 'Bike Talk Podcast' },
    ])
  })

  it('keeps sibling feeds with distinct keys but similar names', () => {
    const out = parseProgramOptions(sample)
    expect(out.map((s) => s.key)).toContain('biketalka')
    expect(out.map((s) => s.key)).toContain('biketalk')
  })

  it('trims KPFT-style leading whitespace in names', () => {
    const html = '<option value="pt" style="x" > Cajun Bandstand'
    expect(parseProgramOptions(html)).toEqual([{ key: 'pt', name: 'Cajun Bandstand' }])
  })

  it('de-dupes a repeated key, keeping the first', () => {
    const html = '<option value="dn" >Democracy Now</option><option value="dn" >Democracy Now Repeat</option>'
    expect(parseProgramOptions(html)).toEqual([{ key: 'dn', name: 'Democracy Now' }])
  })

  it('skips placeholder/non-key options', () => {
    const html = '<option value="">Select a program</option><option value="dn">Democracy Now</option>'
    expect(parseProgramOptions(html)).toEqual([{ key: 'dn', name: 'Democracy Now' }])
  })

  it('falls back to the key when the name is blank', () => {
    expect(parseProgramOptions('<option value="dn"></option>')).toEqual([{ key: 'dn', name: 'dn' }])
  })

  it('returns an empty list when there are no option tags', () => {
    expect(parseProgramOptions('<html><body>no programs here</body></html>')).toEqual([])
  })
})

describe('selectNewShows', () => {
  const discovered = [
    { key: 'dn', name: 'Democracy Now' },
    { key: 'uprising', name: 'Uprising' },
    { key: 'alterradioar', name: 'Alternative Radio' },
  ]

  it('returns only keys not already stored', () => {
    expect(selectNewShows(discovered, ['uprising'])).toEqual([
      { key: 'dn', name: 'Democracy Now' },
      { key: 'alterradioar', name: 'Alternative Radio' },
    ])
  })

  it('matches existing keys case-insensitively', () => {
    expect(selectNewShows(discovered, ['UPRISING', 'DN'])).toEqual([
      { key: 'alterradioar', name: 'Alternative Radio' },
    ])
  })

  it('returns everything when nothing is stored yet', () => {
    expect(selectNewShows(discovered, [])).toEqual(discovered)
  })

  it('returns nothing when all keys already exist', () => {
    expect(selectNewShows(discovered, ['dn', 'uprising', 'alterradioar'])).toEqual([])
  })

  it('de-dupes repeated discovered keys', () => {
    const dupes = [
      { key: 'dn', name: 'Democracy Now' },
      { key: 'dn', name: 'Democracy Now Repeat' },
    ]
    expect(selectNewShows(dupes, [])).toEqual([{ key: 'dn', name: 'Democracy Now' }])
  })
})
