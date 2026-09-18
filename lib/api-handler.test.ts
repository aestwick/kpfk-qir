import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('./api-auth', () => ({
  authenticateApiKey: vi.fn(),
  requireScope: vi.fn(),
}))
vi.mock('./ratelimit', () => ({ checkRateLimit: vi.fn() }))
vi.mock('./api-cache', () => ({ cached: vi.fn() }))

import { withApiKey } from './api-handler'
import { authenticateApiKey, requireScope } from './api-auth'
import { checkRateLimit } from './ratelimit'
import { cached } from './api-cache'

const mAuth = authenticateApiKey as unknown as ReturnType<typeof vi.fn>
const mScope = requireScope as unknown as ReturnType<typeof vi.fn>
const mRate = checkRateLimit as unknown as ReturnType<typeof vi.fn>
const mCached = cached as unknown as ReturnType<typeof vi.fn>

const CTX = { keyId: 1, stationId: 's1', scopes: ['qir'], rateLimitPerMin: 60 }
type NextReqInit = ConstructorParameters<typeof NextRequest>[1]
const req = (init?: NextReqInit) => new NextRequest('http://localhost/api/v1/qir', init)

beforeEach(() => {
  vi.clearAllMocks()
  mAuth.mockResolvedValue({ ctx: CTX })
  mScope.mockReturnValue(null)
  mRate.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, resetSec: 60 })
  // Default: cache passthrough that runs the fetcher and reports a miss.
  mCached.mockImplementation(async (_opts: unknown, fetcher: () => Promise<unknown>) => ({
    value: await fetcher(),
    hit: false,
  }))
})

describe('withApiKey', () => {
  it('401s when authentication fails', async () => {
    mAuth.mockResolvedValue({ error: { status: 401, error: 'Missing API key' } })
    const handler = withApiKey(async () => ({ json: { ok: true } }), { scope: 'qir' })
    const res = await handler(req())
    expect(res.status).toBe(401)
  })

  it('403s when the key lacks the scope', async () => {
    mScope.mockReturnValue({ status: 403, error: "lacks 'qir'" })
    const handler = withApiKey(async () => ({ json: { ok: true } }), { scope: 'qir' })
    const res = await handler(req())
    expect(res.status).toBe(403)
  })

  it('429s with Retry-After when rate limited', async () => {
    mRate.mockResolvedValue({ allowed: false, limit: 5, remaining: 0, resetSec: 12 })
    const handler = withApiKey(async () => ({ json: { ok: true } }), { scope: 'qir' })
    const res = await handler(req())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('12')
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
  })

  it('200s with ETag, rate-limit headers, and X-Cache on success', async () => {
    const handler = withApiKey(async () => ({ json: { reports: [] } }), {
      scope: 'qir',
      cache: { resource: 'qir', ttlSec: 3600 },
    })
    const res = await handler(req())
    expect(res.status).toBe(200)
    expect(res.headers.get('etag')).toBeTruthy()
    expect(res.headers.get('x-cache')).toBe('MISS')
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(res.headers.get('x-ratelimit-limit')).toBe('60')
    expect(await res.json()).toEqual({ reports: [] })
  })

  it('reports X-Cache HIT when the cache serves the value', async () => {
    mCached.mockResolvedValue({ value: { body: '{"reports":[]}', contentType: 'application/json', status: 200 }, hit: true })
    const handler = withApiKey(async () => ({ json: { reports: [] } }), {
      scope: 'qir',
      cache: { resource: 'qir', ttlSec: 3600 },
    })
    const res = await handler(req())
    expect(res.headers.get('x-cache')).toBe('HIT')
  })

  it('returns 304 when If-None-Match matches the ETag', async () => {
    const handler = withApiKey(async () => ({ json: { reports: [] } }), {
      scope: 'qir',
      cache: { resource: 'qir', ttlSec: 3600 },
    })
    const first = await handler(req())
    const etag = first.headers.get('etag')!
    const second = await handler(req({ headers: { 'if-none-match': etag } }))
    expect(second.status).toBe(304)
  })

  it('serves raw body + content-type for non-JSON payloads (VTT)', async () => {
    const handler = withApiKey(async () => ({ body: 'WEBVTT\n\n', contentType: 'text/vtt; charset=utf-8' }), {
      scope: 'transcripts',
    })
    const res = await handler(req())
    expect(res.headers.get('content-type')).toContain('text/vtt')
    expect(await res.text()).toContain('WEBVTT')
  })

  it('surfaces a 500 (and does not cache) when the handler returns >=500', async () => {
    // With a passthrough cache mock, a handler 500 throws out of run() and is
    // surfaced as a generic 500.
    const handler = withApiKey(async () => ({ json: { error: 'boom' }, status: 500 }), {
      scope: 'qir',
      cache: { resource: 'qir', ttlSec: 60 },
    })
    const res = await handler(req())
    expect(res.status).toBe(500)
  })

  it('passes route params through to the handler', async () => {
    const handler = withApiKey(
      async (_r, { params }) => ({ json: { year: params.year } }),
      { scope: 'qir' },
    )
    const res = await handler(req(), { params: { year: '2025' } })
    expect(await res.json()).toEqual({ year: '2025' })
  })
})

// A route whose response depends on a property of the CALLING KEY must declare
// `cache.vary`. Cache entries are shared by every key of a station, so without
// it one key's body is served to another: the episode detail route embeds a
// transcript only for a key holding the 'transcripts' scope, and a shared entry
// hands those captions to a key that lacks the scope on a HIT.
describe('withApiKey — per-key cache vary', () => {
  const subkeys = () => mCached.mock.calls.map((c) => (c[0] as { subkey: string }).subkey)
  const scopedHandler = () =>
    withApiKey(async () => ({ json: { ok: true } }), {
      scope: 'episodes',
      cache: {
        resource: 'episodes',
        ttlSec: 300,
        vary: (ctx) => (ctx.scopes.includes('transcripts') ? 'transcripts' : ''),
      },
    })

  it('omits a discriminator when the route declares no vary', async () => {
    const handler = withApiKey(async () => ({ json: { ok: true } }), {
      scope: 'qir',
      cache: { resource: 'qir', ttlSec: 60 },
    })
    await handler(req())
    expect(subkeys()[0]).toBe('/api/v1/qir?')
  })

  it('separates entries for keys that differ on the varied property', async () => {
    const handler = scopedHandler()

    await handler(req()) // key without the transcripts scope
    mAuth.mockResolvedValue({ ctx: { ...CTX, keyId: 2, scopes: ['episodes', 'transcripts'] } })
    await handler(req()) // key with it

    const [withoutScope, withScope] = subkeys()
    expect(withoutScope).not.toBe(withScope)
    expect(withScope).toContain('transcripts')
    expect(withoutScope).not.toContain('transcripts')
  })

  it('still shares one entry between keys that agree on it', async () => {
    const handler = scopedHandler()

    await handler(req())
    mAuth.mockResolvedValue({ ctx: { ...CTX, keyId: 99 } })
    await handler(req())

    const [a, b] = subkeys()
    expect(a).toBe(b)
  })
})
