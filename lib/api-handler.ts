import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { authenticateApiKey, requireScope, type ApiKeyContext } from './api-auth'
import { checkRateLimit } from './ratelimit'
import { cached } from './api-cache'
import type { ApiScope } from './types'

// ===========================================================================
// withApiKey — the single wrapper every /api/v1 route is built from. It runs the
// request through, in order: API-key auth → scope check → per-key rate limit →
// Redis response cache → the route's handler, then attaches ETag (with
// If-None-Match → 304), Cache-Control, X-RateLimit-*, and X-Cache headers.
//
// Designed for server-to-server consumers (e.g. the podcast app): responses are
// Cache-Control: private (keyed) but still carry a strong ETag so a backend can
// revalidate large, immutable payloads (VTT captions) with a cheap 304.
// ===========================================================================

// What a route handler returns. `json` for the common case; `body`+`contentType`
// for raw payloads like VTT captions. `status` defaults to 200 (use 404 etc).
export type ApiHandlerResult =
  | { json: unknown; status?: number }
  | { body: string; contentType: string; status?: number }

export interface ApiHandlerArgs {
  ctx: ApiKeyContext
  params: Record<string, string>
}

type Handler = (request: NextRequest, args: ApiHandlerArgs) => Promise<ApiHandlerResult>

interface WithApiKeyOptions {
  scope: ApiScope
  // When set, successful responses are cached in Redis under (station, resource)
  // for ttlSec, and Cache-Control max-age mirrors it.
  cache?: { resource: string; ttlSec: number }
}

interface NormalizedResult {
  body: string
  contentType: string
  status: number
}

function normalize(result: ApiHandlerResult): NormalizedResult {
  if ('body' in result) {
    return { body: result.body, contentType: result.contentType, status: result.status ?? 200 }
  }
  return { body: JSON.stringify(result.json), contentType: 'application/json', status: result.status ?? 200 }
}

function etagOf(body: string): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`
}

// Stable cache subkey: path + sorted query string. The API key never enters the
// key — responses depend only on station + params, so all keys for a station
// share cache entries (and can't read each other's data, since station differs).
function cacheSubkey(request: NextRequest): string {
  const params = Array.from(request.nextUrl.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b))
  return request.nextUrl.pathname + '?' + new URLSearchParams(params).toString()
}

function rateLimitHeaders(limit: number, remaining: number, resetSec: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetSec),
  }
}

export function withApiKey(handler: Handler, opts: WithApiKeyOptions) {
  return async (
    request: NextRequest,
    routeCtx?: { params?: Record<string, string> },
  ): Promise<Response> => {
    // 1. Authenticate the key.
    const auth = await authenticateApiKey(request)
    if (auth.error) {
      return NextResponse.json({ error: auth.error.error }, { status: auth.error.status })
    }
    const ctx = auth.ctx

    // 2. Scope gate.
    const denied = requireScope(ctx, opts.scope)
    if (denied) {
      return NextResponse.json({ error: denied.error }, { status: denied.status })
    }

    // 3. Per-key rate limit.
    const rl = await checkRateLimit(ctx.keyId, ctx.rateLimitPerMin)
    const rlHeaders = rateLimitHeaders(rl.limit, rl.remaining, rl.resetSec)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429, headers: { ...rlHeaders, 'Retry-After': String(rl.resetSec) } },
      )
    }

    const params = routeCtx?.params ?? {}

    // 4. Run the handler, through the response cache when configured. 5xx results
    //    throw out of run() so they are surfaced as 500 and never cached.
    const run = async (): Promise<NormalizedResult> => {
      const result = await handler(request, { ctx, params })
      const norm = normalize(result)
      if (norm.status >= 500) throw new Error(`handler returned ${norm.status}`)
      return norm
    }

    let entry: NormalizedResult
    let cacheStatus = 'BYPASS'
    try {
      if (opts.cache) {
        const c = await cached(
          { stationId: ctx.stationId, resource: opts.cache.resource, subkey: cacheSubkey(request), ttlSec: opts.cache.ttlSec },
          run,
        )
        entry = c.value
        cacheStatus = c.hit ? 'HIT' : 'MISS'
      } else {
        entry = await run()
      }
    } catch (err) {
      console.error('api/v1 handler failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Internal error' }, { status: 500, headers: rlHeaders })
    }

    // 5. ETag / conditional request.
    const etag = etagOf(entry.body)
    const maxAge = opts.cache && entry.status < 400 ? opts.cache.ttlSec : 0
    const headers: Record<string, string> = {
      ...rlHeaders,
      'Content-Type': entry.contentType,
      ETag: etag,
      'Cache-Control': maxAge > 0 ? `private, max-age=${maxAge}` : 'private, no-store',
      'X-Cache': cacheStatus,
    }

    const inm = request.headers.get('if-none-match')
    if (inm && inm === etag && entry.status < 400) {
      return new Response(null, { status: 304, headers })
    }

    return new Response(entry.body, { status: entry.status, headers })
  }
}
