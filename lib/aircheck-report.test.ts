import { describe, it, expect } from 'vitest'
import { isMiss, scannable, showScorecard } from './aircheck-report'
import type { BoundaryResult, StreamNightScan } from './aircheck'

function boundary(over: Partial<BoundaryResult> = {}): BoundaryResult {
  return {
    kind: 'top',
    atSec: 72000,
    strength: 'none',
    episodeId: 1,
    showKey: 'show',
    showName: 'Show',
    evidence: null,
    coveredByNeighbor: false,
    noCoverage: false,
    cityInWindow: false,
    ...over,
  }
}

function night(boundaries: BoundaryResult[], stream = 'main'): StreamNightScan {
  return { date: '2026-08-14', stream, boundaries, episodes: [] }
}

describe('isMiss', () => {
  it('counts a mark with captions but no station ID', () => {
    expect(isMiss(boundary({ strength: 'none' }))).toBe(true)
  })

  it('does not blame a host for a mark that had no captions at all', () => {
    expect(isMiss(boundary({ strength: 'none', noCoverage: true }))).toBe(false)
  })

  it('does not count a mark where an ID was found', () => {
    expect(isMiss(boundary({ strength: 'legal' }))).toBe(false)
    expect(isMiss(boundary({ strength: 'frequency' }))).toBe(false)
  })
})

describe('scannable', () => {
  it('drops marks with no captions', () => {
    const list = [boundary(), boundary({ noCoverage: true }), boundary({ strength: 'legal' })]
    expect(scannable(list)).toHaveLength(2)
  })
})

describe('showScorecard', () => {
  it('rates a show on its scorable marks only', () => {
    const rows = showScorecard([
      night([
        boundary({ showKey: 'a', showName: 'A', strength: 'none' }),
        boundary({ showKey: 'a', showName: 'A', strength: 'legal' }),
        boundary({ showKey: 'a', showName: 'A', strength: 'none', noCoverage: true }),
      ]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'A', total: 3, scored: 2, none: 1, legal: 1, noCov: 1 })
  })

  it('omits a show whose every mark was unscorable rather than scoring it 0%', () => {
    const rows = showScorecard([
      night([
        boundary({ showKey: 'dead', showName: 'Dead', noCoverage: true }),
        boundary({ showKey: 'dead', showName: 'Dead', noCoverage: true }),
      ]),
    ])
    expect(rows).toEqual([])
  })

  it('keeps the same show on different streams apart', () => {
    const rows = showScorecard([
      night([boundary({ showKey: 'a', showName: 'A', strength: 'none' })], 'main'),
      night([boundary({ showKey: 'a', showName: 'A', strength: 'legal' })], 'stream 2'),
    ])
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.stream).sort()).toEqual(['main', 'stream 2'])
  })

  it('orders worst-first by missing rate', () => {
    const rows = showScorecard([
      night([
        boundary({ showKey: 'good', showName: 'Good', strength: 'legal' }),
        boundary({ showKey: 'good', showName: 'Good', strength: 'legal' }),
        boundary({ showKey: 'bad', showName: 'Bad', strength: 'none' }),
        boundary({ showKey: 'bad', showName: 'Bad', strength: 'none' }),
      ]),
    ])
    expect(rows.map((r) => r.name)).toEqual(['Bad', 'Good'])
  })
})
