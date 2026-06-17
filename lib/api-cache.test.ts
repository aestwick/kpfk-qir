import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory fake of the bits of ioredis that api-cache uses (get/set/incr).
const store = new Map<string, string>()
const fakeRedis = {
  async get(key: string) {
    return store.has(key) ? store.get(key)! : null
  },
  async set(key: string, val: string, _ex: string, _ttl: number) {
    store.set(key, val)
    return 'OK'
  },
  async incr(key: string) {
    const next = Number(store.get(key) ?? '0') + 1
    store.set(key, String(next))
    return next
  },
}

vi.mock('./redis', () => ({ getRedis: () => fakeRedis }))

import { cached, bumpCacheVersion } from './api-cache'

const opts = (subkey = 'x') => ({ stationId: 's1', resource: 'qir', subkey, ttlSec: 60 })

describe('api-cache', () => {
  beforeEach(() => store.clear())

  it('misses then hits for the same key', async () => {
    const fetcher = vi.fn().mockResolvedValue({ a: 1 })

    const first = await cached(opts(), fetcher)
    expect(first).toEqual({ value: { a: 1 }, hit: false })

    const second = await cached(opts(), fetcher)
    expect(second).toEqual({ value: { a: 1 }, hit: true })

    expect(fetcher).toHaveBeenCalledTimes(1) // second served from cache
  })

  it('keys are isolated by subkey', async () => {
    const f1 = vi.fn().mockResolvedValue('one')
    const f2 = vi.fn().mockResolvedValue('two')
    await cached(opts('a'), f1)
    const r = await cached(opts('b'), f2)
    expect(r.value).toBe('two')
    expect(f2).toHaveBeenCalledOnce()
  })

  it('keys are isolated by station (no cross-tenant bleed)', async () => {
    await cached({ ...opts(), stationId: 's1' }, vi.fn().mockResolvedValue('s1-data'))
    const other = await cached({ ...opts(), stationId: 's2' }, vi.fn().mockResolvedValue('s2-data'))
    expect(other).toEqual({ value: 's2-data', hit: false })
  })

  it('bumpCacheVersion invalidates prior entries', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('v0').mockResolvedValueOnce('v1')

    const a = await cached(opts(), fetcher)
    expect(a).toEqual({ value: 'v0', hit: false })

    await bumpCacheVersion('s1', 'qir')

    const b = await cached(opts(), fetcher)
    expect(b).toEqual({ value: 'v1', hit: false }) // version bump forced a miss
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('fails open when redis throws on read', async () => {
    const spy = vi.spyOn(fakeRedis, 'get').mockRejectedValueOnce(new Error('down'))
    const r = await cached(opts(), vi.fn().mockResolvedValue('fresh'))
    expect(r).toEqual({ value: 'fresh', hit: false })
    spy.mockRestore()
  })
})
