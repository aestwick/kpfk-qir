import { describe, it, expect } from 'vitest'
import { parseEntryDate, summarizeDateSpread, spreadCandidates } from './qir-format'

describe('parseEntryDate', () => {
  it('parses ISO and the long display form to the same UTC day', () => {
    expect(parseEntryDate('2026-07-17')?.toISOString()).toBe('2026-07-17T00:00:00.000Z')
    expect(parseEntryDate('Friday, July 17, 2026')?.toISOString()).toBe('2026-07-17T00:00:00.000Z')
  })

  it('returns null for empty or unparseable input', () => {
    expect(parseEntryDate('')).toBeNull()
    expect(parseEntryDate(null)).toBeNull()
    expect(parseEntryDate('sometime')).toBeNull()
  })
})

describe('summarizeDateSpread', () => {
  it('measures long-form dates chronologically, not by weekday name', () => {
    // The KPFK Q3 2026 draft: a string sort put "Friday, July 17" first and
    // "Wednesday, July 8" last, scoring -9 days across 7 "months".
    expect(
      summarizeDateSpread(['Friday, July 17, 2026', 'Wednesday, July 1, 2026', 'Sunday, July 26, 2026', 'Wednesday, July 8, 2026'])
    ).toEqual({ spanDays: 25, months: 1 })
  })

  it('counts calendar months across a mixed-format quarter', () => {
    expect(summarizeDateSpread(['2026-07-01', 'Monday, August 17, 2026', '2026-09-30'])).toEqual({ spanDays: 91, months: 3 })
  })

  it('is null with fewer than two parseable dates', () => {
    expect(summarizeDateSpread(['2026-07-01', ''])).toBeNull()
  })
})

describe('spreadCandidates', () => {
  // One entry per day across Q3 (92 days), date-ascending like the DB query.
  const days = Array.from({ length: 92 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 6, 1 + i))
    return { id: i, date: d.toISOString().slice(0, 10), good: i % 7 === 3 }
  })
  const get = (e: { date: string }) => e.date
  const score = (e: { good: boolean }) => (e.good ? 1 : 0)

  it('returns everything when under the cap', () => {
    expect(spreadCandidates(days.slice(0, 5), 10, get, score)).toHaveLength(5)
  })

  it('covers every month of the quarter instead of the first N days', () => {
    const picked = spreadCandidates(days, 20, get, score)
    expect(picked).toHaveLength(20)
    expect(new Set(picked.map((e) => e.date.slice(0, 7)))).toEqual(new Set(['2026-07', '2026-08', '2026-09']))
  })

  it('takes the highest-scoring entry of each week first, interleaved in time', () => {
    const picked = spreadCandidates(days, 14, get, score)
    // The first round takes one entry per week — the good one wherever that week has one.
    const firstRound = picked.slice(0, 13)
    expect(firstRound.filter((e) => e.good).length).toBeGreaterThanOrEqual(12)
    const times = firstRound.map((e) => Date.parse(e.date))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('puts undated entries in a trailing bucket', () => {
    const withUndated = [...days, { id: 999, date: '', good: true }]
    const picked = spreadCandidates(withUndated, 15, get, score)
    expect(picked.map((e) => e.id)).toContain(999)
  })
})
