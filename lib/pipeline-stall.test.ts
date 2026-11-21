import { describe, it, expect } from 'vitest'
import { detectTranscriptionStall } from './pipeline-stall'

const now = new Date('2026-11-21T05:00:00Z')
const base = { paused: false, pendingCount: 74, now }

describe('detectTranscriptionStall', () => {
  it('flags the 2026-11-18 incident: work waiting, nothing transcribed for days', () => {
    const s = detectTranscriptionStall({
      ...base,
      oldestPendingAt: '2026-11-18T07:17:43Z',
      lastTranscribedAt: '2026-11-18T06:04:24Z',
    })
    expect(s).not.toBeNull()
    expect(s!.pendingCount).toBe(74)
    // Stall starts when the oldest episode began waiting (after the last success).
    expect(s!.stalledSince).toBe('2026-11-18T07:17:43.000Z')
    expect(s!.hours).toBe(69)
  })

  it('stays quiet while a backlog is actively draining', () => {
    expect(detectTranscriptionStall({
      ...base, oldestPendingAt: '2026-11-20T00:00:00Z', lastTranscribedAt: '2026-11-21T04:50:00Z',
    })).toBeNull()
  })

  it('stays quiet for freshly ingested work (under 2h)', () => {
    expect(detectTranscriptionStall({
      ...base, oldestPendingAt: '2026-11-21T04:03:00Z', lastTranscribedAt: '2026-11-18T06:04:00Z',
    })).toBeNull()
  })

  it('stays quiet when paused or when nothing is pending', () => {
    const stale = { oldestPendingAt: '2026-11-18T07:00:00Z', lastTranscribedAt: null }
    expect(detectTranscriptionStall({ ...base, ...stale, paused: true })).toBeNull()
    expect(detectTranscriptionStall({ ...base, ...stale, pendingCount: 0 })).toBeNull()
  })

  it('handles a station that has never transcribed anything', () => {
    const s = detectTranscriptionStall({ ...base, oldestPendingAt: '2026-11-21T01:00:00Z', lastTranscribedAt: null })
    expect(s?.hours).toBe(4)
  })
})
