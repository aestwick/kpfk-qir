import { getRedis } from './redis'

// ===========================================================================
// Redis response cache for the keyed read API — the origin shield. Identical
// requests are served from Redis so Supabase sees one query per (station,
// resource, params) per TTL window instead of one per request.
//
// Invalidation is VERSIONED rather than key-scanning: each (station, resource)
// has a monotonically increasing version int, and that version is folded into
// every cache key. Bumping the version (INCR) instantly orphans all prior
// entries for that resource — no SCAN/DEL, no stampede. Orphaned entries age
// out via their own TTL. This is what the QIR finalize hook calls so a freshly
// finalized report is visible immediately.
// ===========================================================================

// Namespace. BUMP THIS whenever a deploy changes what a cached body contains —
// its SHAPE as well as its permissions. Entries written by the previous build
// survive the deploy and are served for up to their TTL, so without a bump:
//   - a new authorization rule is bypassed by the warm cache (v2), or
//   - consumers see two different payload schemas at once during rollout (v3),
//     which is worse than either schema, because a parser that handles both is
//     not a parser anyone wrote.
// Changing only HOW a body is computed needs no bump. Orphaned entries age out
// on their own TTL; the cost of a bump is a cold period, nothing more.
//
//   v2 — published gate on the episode detail/transcript routes
//   v3 — duration → duration_minutes + duration_seconds in the episode payload
const NS = 'qir:apicache:v3'

export interface CacheResult<T> {
  value: T
  hit: boolean
}

async function resourceVersion(stationId: string, resource: string): Promise<number> {
  try {
    const v = await getRedis().get(`${NS}:ver:${stationId}:${resource}`)
    return v ? Number(v) : 0
  } catch {
    return 0
  }
}

/** Bump the version for a (station, resource), invalidating its cached responses. */
export async function bumpCacheVersion(stationId: string, resource: string): Promise<void> {
  try {
    await getRedis().incr(`${NS}:ver:${stationId}:${resource}`)
  } catch (err) {
    console.error('bumpCacheVersion failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Return a cached JSON value for `subkey` (under a station+resource namespace),
 * or run `fetcher`, cache its result for `ttlSec`, and return it. Fails OPEN: on
 * any Redis error the fetcher runs and the result is returned uncached, so a
 * Redis outage degrades to direct DB reads rather than 500s.
 */
export async function cached<T>(
  opts: { stationId: string; resource: string; subkey: string; ttlSec: number },
  fetcher: () => Promise<T>,
): Promise<CacheResult<T>> {
  const { stationId, resource, subkey, ttlSec } = opts
  let key: string | null = null

  try {
    const ver = await resourceVersion(stationId, resource)
    key = `${NS}:v${ver}:${stationId}:${resource}:${subkey}`
    const raw = await getRedis().get(key)
    if (raw !== null) {
      return { value: JSON.parse(raw) as T, hit: true }
    }
  } catch (err) {
    console.error('cache read failed (falling through to fetcher):', err instanceof Error ? err.message : err)
    key = null
  }

  const value = await fetcher()

  if (key) {
    try {
      await getRedis().set(key, JSON.stringify(value), 'EX', ttlSec)
    } catch (err) {
      console.error('cache write failed:', err instanceof Error ? err.message : err)
    }
  }

  return { value, hit: false }
}
