import { describe, it, expect } from 'vitest'
import { stationWallClock, stationEndClock, stationTimeZone } from './station-time'

describe('stationWallClock', () => {
  // kpfthd3_260627_160000quantum.mp3 aired 4:00 PM Central = 21:00Z (CDT).
  const instant = '2026-06-27T21:00:00Z'
  it('renders the instant in the station’s own zone (KPFT, Central)', () => {
    expect(stationWallClock(instant, 'America/Chicago')).toEqual({
      date: 'Saturday, June 27, 2026', airDate: '2026-06-27', startTime: '4:00 PM', airStart: '16:00:00',
    })
  })
  it('still gives Pacific for KPFK', () => {
    expect(stationWallClock(instant, 'America/Los_Angeles').airStart).toBe('14:00:00')
  })
  it('puts a late-night airing on the station-local date, not the UTC one', () => {
    // 11:30 PM Eastern Sep 30 = 03:30Z Oct 1 → stays in Q3 for WPFW.
    expect(stationWallClock('2026-10-01T03:30:00Z', 'America/New_York')).toMatchObject({ airDate: '2026-09-30', airStart: '23:30:00' })
  })
  it('handles midnight as 00:00:00', () => {
    expect(stationWallClock('2026-07-01T05:00:00Z', 'America/Chicago').airStart).toBe('00:00:00')
  })
})

describe('stationEndClock', () => {
  it('adds the duration in the station zone', () => {
    expect(stationEndClock(Date.parse('2026-06-27T21:00:00Z'), 60, 'America/Chicago')).toEqual({ endTime: '5:00 PM', airEnd: '17:00:00' })
  })
  it('is empty without a duration', () => {
    expect(stationEndClock(0, null, 'America/Chicago')).toEqual({ endTime: '', airEnd: '' })
  })
})

describe('stationTimeZone', () => {
  it('falls back to Pacific for a missing or bogus zone', () => {
    expect(stationTimeZone(null)).toBe('America/Los_Angeles')
    expect(stationTimeZone('Mars/Olympus')).toBe('America/Los_Angeles')
    expect(stationTimeZone('America/Chicago')).toBe('America/Chicago')
  })
})
