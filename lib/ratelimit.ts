import { getRedis } from './redis'

// ===========================================================================
// Per-key sliding-window rate limiter. Backs the keyed read API so a burst of
// requests is throttled at the edge BEFORE it reaches Supabase (the response
// cache shields warm reads; this caps the cold/abusive ones).
//
// Implemented as an atomic sliding-window log in a single EVAL (mirrors the
// Lua+eval approach in lib/locks.ts): record this hit, drop hits older than the
// window, count what remains, and re-arm the key's TTL. Atomicity means
// concurrent requests can't slip past the limit via a check-then-act race.
// ===========================================================================

const WINDOW_MS = 60_000

// KEYS[1] = bucket key; ARGV[1] = now(ms); ARGV[2] = window(ms);
// ARGV[3] = limit; ARGV[4] = unique member id.
// Returns {allowed(1/0), count, oldestMsInWindow}.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, count, oldest[2]}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return {1, count + 1, now}
`

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the window frees up a slot (for Retry-After). */
  resetSec: number
}

/**
 * Check (and consume, when allowed) one request against a per-id sliding window.
 * `id` is typically the API key id. Fails OPEN: if Redis is unreachable the
 * request is allowed rather than 500'd (availability over strict limiting), and
 * the error is logged.
 */
export async function checkRateLimit(id: string | number, limitPerMin: number): Promise<RateLimitResult> {
  const key = `qir:ratelimit:${id}`
  const now = Date.now()
  const member = `${now}-${Math.random().toString(36).slice(2)}`

  try {
    const res = (await getRedis().eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(WINDOW_MS),
      String(limitPerMin),
      member,
    )) as [number, number, string | null]

    const allowed = res[0] === 1
    const count = res[1]
    const oldest = res[2] ? Number(res[2]) : now
    const resetSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000))

    return {
      allowed,
      limit: limitPerMin,
      remaining: Math.max(0, limitPerMin - count),
      resetSec: allowed ? Math.ceil(WINDOW_MS / 1000) : resetSec,
    }
  } catch (err) {
    console.error('checkRateLimit failed (failing open):', err instanceof Error ? err.message : err)
    return { allowed: true, limit: limitPerMin, remaining: limitPerMin, resetSec: Math.ceil(WINDOW_MS / 1000) }
  }
}
