import { describe, it, expect } from 'vitest'
import { getProcessingWindowBounds, getCurrentQuarterBounds, QUARTER_GRACE_DAYS } from './quarters'

// Local-clock constructors (month is 0-based) to match how quarters.ts reads `now`.
describe('getProcessingWindowBounds', () => {
  it('uses grace of 10 days', () => {
    expect(QUARTER_GRACE_DAYS).toBe(10)
  })

  it('mid-quarter: identical to the current quarter (no grace)', () => {
    const now = new Date(2026, 10, 15, 12) // Nov 15
    expect(getProcessingWindowBounds(now)).toEqual({ start: '2026-10-01', end: '2026-12-31' })
    expect(getProcessingWindowBounds(now)).toEqual(getCurrentQuarterBounds(now))
  })

  it('day 1 of the quarter: reaches back to the previous quarter start', () => {
    expect(getProcessingWindowBounds(new Date(2026, 9, 1, 12))).toEqual({
      start: '2026-07-01',
      end: '2026-12-31',
    })
  })

  it('last grace day (day 10): still includes the previous quarter', () => {
    expect(getProcessingWindowBounds(new Date(2026, 9, 10, 23, 59))).toEqual({
      start: '2026-07-01',
      end: '2026-12-31',
    })
  })

  it('first day after grace (day 11): current quarter only', () => {
    expect(getProcessingWindowBounds(new Date(2026, 9, 11, 0, 0))).toEqual({
      start: '2026-10-01',
      end: '2026-12-31',
    })
  })

  it('Q1 grace reaches back into the previous year Q4', () => {
    expect(getProcessingWindowBounds(new Date(2027, 0, 5, 9))).toEqual({
      start: '2026-10-01',
      end: '2027-03-31',
    })
  })

  it('exact boundary instant: last ms of Q3 is Q3-only, first ms of Q4 gets grace', () => {
    expect(getProcessingWindowBounds(new Date(2026, 8, 30, 23, 59, 59, 999))).toEqual({
      start: '2026-07-01',
      end: '2026-09-30',
    })
    expect(getProcessingWindowBounds(new Date(2026, 9, 1, 0, 0, 0, 0))).toEqual({
      start: '2026-07-01',
      end: '2026-12-31',
    })
  })
})
