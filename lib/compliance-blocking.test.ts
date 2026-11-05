import { describe, it, expect } from 'vitest'
import { isBlockingFlag, summarizeBlockedEpisodes, complianceValidation, type BlockingStatus } from './compliance-blocking'

describe('isBlockingFlag', () => {
  it('blocks on critical flags that are not dismissed — including unreviewed ones', () => {
    expect(isBlockingFlag({ severity: 'critical', review_status: 'suggested' })).toBe(true)
    expect(isBlockingFlag({ severity: 'critical', review_status: 'investigating' })).toBe(true)
    expect(isBlockingFlag({ severity: 'critical', review_status: 'violation' })).toBe(true)
  })
  it('a dismissed critical flag no longer blocks', () => {
    expect(isBlockingFlag({ severity: 'critical', review_status: 'dismissed' })).toBe(false)
  })
  it('warnings never block', () => {
    expect(isBlockingFlag({ severity: 'warning', review_status: 'violation' })).toBe(false)
    expect(isBlockingFlag({ severity: 'warning', review_status: 'suggested' })).toBe(false)
  })
})

describe('summarizeBlockedEpisodes', () => {
  it('groups by episode, counts blocking + unreviewed, ignores non-blocking rows', () => {
    const out = summarizeBlockedEpisodes([
      { episode_id: 7, severity: 'critical', review_status: 'suggested' },
      { episode_id: 7, severity: 'critical', review_status: 'investigating' },
      { episode_id: 7, severity: 'critical', review_status: 'dismissed' },
      { episode_id: 3, severity: 'critical', review_status: 'suggested' },
      { episode_id: 9, severity: 'warning', review_status: 'suggested' },
      { episode_id: 11, severity: 'critical', review_status: 'dismissed' },
    ])
    expect(out).toEqual([
      { episode_id: 3, blocking_flags: 1, unreviewed: 1 },
      { episode_id: 7, blocking_flags: 2, unreviewed: 1 },
    ])
  })
  it('returns nothing when no flag blocks', () => {
    expect(summarizeBlockedEpisodes([])).toEqual([])
  })
})


const status = (over: Partial<BlockingStatus>): BlockingStatus => ({
  blocking_enabled: true, blocked: [], blocking_flags: 0, unreviewed_flags: 0, ...over,
})

describe('complianceValidation', () => {
  it('is pending until blocking status loads', () => {
    expect(complianceValidation(null, { total: 0, critical: 0 }).detail).toMatch(/Checking/)
  })

  it('blocking on, nothing held out → pass and says blocking is on', () => {
    const r = complianceValidation(status({}), { total: 0, critical: 0 })
    expect(r.status).toBe('pass')
    expect(r.detail).toMatch(/blocking is on/)
  })

  it('blocking on counts held-out episodes even with zero "active" flags (the bug)', () => {
    // 69 unreviewed critical flags, none investigating/violation: the old
    // check said "No active compliance flags" while episodes were blocked.
    const r = complianceValidation(
      status({ blocked: [{ episode_id: 1 }, { episode_id: 2 }], blocking_flags: 69, unreviewed_flags: 69 }),
      { total: 0, critical: 0 },
    )
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('2 episodes held out')
    expect(r.detail).toContain('69 critical flags')
    expect(r.detail).toContain('69 never reviewed')
  })

  it('blocking off with undismissed critical flags → warn (they may be in the draft)', () => {
    const r = complianceValidation(
      status({ blocking_enabled: false, blocked: [{ episode_id: 1 }], blocking_flags: 1, unreviewed_flags: 1 }),
      { total: 0, critical: 0 },
    )
    expect(r.status).toBe('warn')
    expect(r.detail).toMatch(/blocking is off/)
    expect(r.detail).toContain('1 episode with')
  })

  it('blocking off with confirmed active critical flags still fails, as before', () => {
    const r = complianceValidation(
      status({ blocking_enabled: false, blocked: [{ episode_id: 1 }], blocking_flags: 1 }),
      { total: 1, critical: 1 },
    )
    expect(r.status).toBe('fail')
  })

  it('blocking off and clean falls back to the active summary', () => {
    expect(complianceValidation(status({ blocking_enabled: false }), { total: 3, critical: 0 }).status).toBe('warn')
    expect(complianceValidation(status({ blocking_enabled: false }), { total: 0, critical: 0 }).status).toBe('pass')
  })
})
