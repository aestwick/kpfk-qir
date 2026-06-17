import { NextRequest } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { supabaseAdmin } from './supabase'
import type { ApiScope } from './types'

// ===========================================================================
// API key authentication for the programmatic read API (app/api/v1/*).
//
// Keys are station-scoped secrets minted by station admins (see app/api/keys).
// The raw secret is shown to the operator exactly once at creation; we persist
// only its sha256 hash. Authentication is a single indexed lookup by hash.
//
// This is deliberately SEPARATE from lib/auth.ts#getStationContext (which
// authenticates dashboard users via a Supabase JWT). An API key is not a JWT;
// it grants service-role-backed reads scoped to one station, with tenancy
// enforced by an explicit station_id filter at the query layer (the worker
// convention — see CLAUDE.md). RLS on api_keys is the backstop; the
// authenticator itself reads via the service role.
// ===========================================================================

const KEY_PREFIX = 'qir_live_'

export interface ApiKeyContext {
  keyId: number
  stationId: string
  scopes: string[]
  rateLimitPerMin: number
}

export interface ApiAuthError {
  status: 401 | 403 | 429
  error: string
}

export type ApiAuthResult =
  | { ctx: ApiKeyContext; error?: undefined }
  | { ctx?: undefined; error: ApiAuthError }

/** sha256 hex of the raw key — what we store and look up by. */
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

/**
 * Mint a fresh key. Returns the raw secret (shown to the operator ONCE), its
 * hash (persisted), and a short non-secret prefix for UI identification.
 */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = KEY_PREFIX + randomBytes(24).toString('base64url')
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) }
}

/** Read the key from `Authorization: Bearer <key>` or the `x-api-key` header. */
function extractKey(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization')
  if (header) {
    const [scheme, token] = header.split(' ')
    if (scheme?.toLowerCase() === 'bearer' && token) return token
  }
  return request.headers.get('x-api-key')
}

// Throttle last_used_at writes so a busy key doesn't generate an UPDATE per
// request. Process-local memory of the last time we stamped each key.
const lastStamped = new Map<number, number>()
const STAMP_INTERVAL_MS = 60_000

/**
 * Authenticate an API key. On success returns the key's station + scopes +
 * rate limit. Never throws into the request path. Fire-and-forget bumps
 * last_used_at at most once per minute per key.
 */
export async function authenticateApiKey(request: NextRequest): Promise<ApiAuthResult> {
  const raw = extractKey(request)
  if (!raw) {
    return { error: { status: 401, error: 'Missing API key (Authorization: Bearer <key> or x-api-key)' } }
  }

  const hash = hashApiKey(raw)
  const { data, error } = await supabaseAdmin
    .from('api_keys')
    .select('id, station_id, scopes, rate_limit_per_min, active')
    .eq('key_hash', hash)
    .maybeSingle()

  if (error) {
    console.error('authenticateApiKey lookup failed:', error.message)
    return { error: { status: 401, error: 'Could not validate API key' } }
  }
  if (!data || !data.active) {
    return { error: { status: 401, error: 'Invalid or revoked API key' } }
  }

  // Throttled, fire-and-forget last_used_at stamp.
  const now = Date.now()
  const prev = lastStamped.get(data.id) ?? 0
  if (now - prev > STAMP_INTERVAL_MS) {
    lastStamped.set(data.id, now)
    void supabaseAdmin
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(({ error: e }) => {
        if (e) console.error('last_used_at stamp failed:', e.message)
      })
  }

  return {
    ctx: {
      keyId: data.id,
      stationId: data.station_id,
      scopes: data.scopes ?? [],
      rateLimitPerMin: data.rate_limit_per_min ?? 60,
    },
  }
}

/** 403-shaped error when the key lacks `scope`, else null. */
export function requireScope(ctx: ApiKeyContext, scope: ApiScope): ApiAuthError | null {
  if (ctx.scopes.includes(scope)) return null
  return { status: 403, error: `This API key lacks the '${scope}' scope` }
}
