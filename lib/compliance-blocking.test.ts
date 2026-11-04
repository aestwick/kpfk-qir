import { describe, it, expect } from 'vitest'
import { isBlockingFlag, summarizeBlockingFlags } from './compliance-blocking'

describe('isBlockingFlag', () => {
  it('blocks critical flags in every status except dismissed — including unreviewed suggestions', () => {
    expect(isBlockingFlag({ severity: 'critical', review_status: 'suggested' })).toBe(true)
    expect(isBlockingFlag({ severity: 'critical', review_status: 'investigating' })).toBe(true)
    expect(isBlockingFlag({ severity: 'critical', review_status: 'violation' })).toBe(true)
    expect(isBlockingFlag({ severity: 'critical', review_status: 'dismissed' })).toBe(false)
  })
  it('never blocks on warnings', () => {
    expect(isBlockingFlag({ severity: 'warning', review_status: 'violation' })).toBe(false)
    expect(isBlockingFlag({ severity: 'warning', review_status: 'suggested' })).toBe(false)
  })
})

describe('summarizeBlockingFlags', () => {
  it('groups by episode, counts unreviewed, dedupes flag types', () => {
    const out = summarizeBlockingFlags([
      { episode_id: 7, flag_type: 'profanity', review_status: 'suggested' },
      { episode_id: 3, flag_type: 'indecency', review_status: 'violation' },
      { episode_id: 7, flag_type: 'profanity', review_status: 'investigating' },
      { episode_id: 7, flag_type: 'indecency', review_status: null },
    ])
    expect(out).toEqual([
      { episode_id: 3, flag_count: 1, unreviewed_count: 0, flag_types: ['indecency'] },
      { episode_id: 7, flag_count: 3, unreviewed_count: 2, flag_types: ['profanity', 'indecency'] },
    ])
  })
  it('returns nothing for no flags', () => {
    expect(summarizeBlockingFlags([])).toEqual([])
  })
})
