import { describe, it, expect } from 'vitest'
import { parseLooseJson, confessorUrl, projectPubfile } from './confessor'

describe('parseLooseJson', () => {
  it('parses clean JSON', () => {
    expect(parseLooseJson('[{"a":1}]')).toEqual([{ a: 1 }])
  })

  it('trims PHP notices prepended before the JSON body', () => {
    // The Confessor API prepends PHP warnings on some endpoints (documented quirk).
    const dirty = 'Notice: Undefined index foo in /x.php on line 10\n[{"mp3":"u"}]'
    expect(parseLooseJson(dirty)).toEqual([{ mp3: 'u' }])
  })

  it('handles a leading object as well as an array', () => {
    expect(parseLooseJson('Warning: bad\n{"k":"v"}')).toEqual({ k: 'v' })
  })

  it('throws when there is no JSON payload', () => {
    expect(() => parseLooseJson('Fatal error: boom')).toThrow()
  })
})

describe('confessorUrl', () => {
  it('builds a fil request with json=1 appended', () => {
    const u = confessorUrl('https://confessor.kpfk.org/_nu_do_api.php', 'fil', { id: 'dn', num: 3 })
    expect(u).toBe('https://confessor.kpfk.org/_nu_do_api.php?req=fil&id=dn&num=3&json=1')
  })
})

describe('projectPubfile', () => {
  it('returns all-null for an empty/absent pubfile', () => {
    expect(projectPubfile(undefined)).toEqual({
      host: null, guest: null, issueCategory: null, humanSummary: null,
    })
    expect(projectPubfile([])).toEqual({
      host: null, guest: null, issueCategory: null, humanSummary: null,
    })
  })

  it('projects a single segment with just a guest', () => {
    const p = projectPubfile([{ pf_gname: 'Jane Roe' }])
    expect(p.guest).toBe('Jane Roe')
    expect(p.host).toBeNull()
    expect(p.issueCategory).toBeNull()
    expect(p.humanSummary).toBe('Jane Roe')
  })

  it('aggregates host, distinct guests and issues across segments', () => {
    const p = projectPubfile([
      { pf_host: 'Sonali', pf_gname: 'A', pf_issue1: 'Health', pf_issue2: 'Immigration' },
      { pf_host: 'Sonali', pf_gname: 'B', pf_issue1: 'Health', pf_gtopic: 'Border policy' },
    ])
    expect(p.host).toBe('Sonali')
    expect(p.guest).toBe('A, B')
    // distinct + deduped (Health appears twice)
    expect(p.issueCategory).toBe('Health, Immigration')
  })

  it('weaves topic and notes into a human rundown, dropping empty pieces', () => {
    const p = projectPubfile([
      { pf_gname: 'Dr. Smith', pf_gtopic: 'Vaccines', pf_notes: 'Full hour interview' },
      { pf_notes: 'Closing segment on local news' },
    ])
    expect(p.humanSummary).toBe(
      'Dr. Smith — Vaccines: Full hour interview\n\nClosing segment on local news'
    )
  })
})
