import { describe, it, expect, vi, beforeEach } from 'vitest'

// The sliding window itself runs as a Lua script inside Redis; here we mock the
// eval return value and assert the JS mapping (allowed / remaining / resetSec)
// and the fail-open behavior.
const evalMock = vi.fn()
vi.mock('./redis', () => ({ getRedis: () => ({ eval: evalMock }) }))

import { checkRateLimit } from './ratelimit'

describe('checkRateLimit', () => {
  beforeEach(() => evalMock.mockReset())

  it('allows and reports remaining when under the limit', async () => {
    // [allowed, count, now]
    evalMock.mockResolvedValue([1, 3, Date.now()])
    const r = await checkRateLimit('key1', 10)
    expect(r.allowed).toBe(true)
    expect(r.limit).toBe(10)
    expect(r.remaining).toBe(7) // 10 - 3
  })

  it('blocks with a positive reset when at the limit', async () => {
    const oldest = Date.now() - 50_000 // 50s into the 60s window
    evalMock.mockResolvedValue([0, 10, String(oldest)])
    const r = await checkRateLimit('key1', 10)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
    expect(r.resetSec).toBeGreaterThan(0)
    expect(r.resetSec).toBeLessThanOrEqual(11) // ~10s left, rounded up
  })

  it('fails open if redis misbehaves (availability over strict limiting)', async () => {
    // A null/garbage reply makes checkRateLimit's own parsing throw, exercising
    // its catch (fail-open). Equivalent to a Redis error, without the mock itself
    // throwing (which vitest would surface as a test error).
    evalMock.mockResolvedValue(null)
    const r = await checkRateLimit('key1', 10)
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(10)
  })
})
