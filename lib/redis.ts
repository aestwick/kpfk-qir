import IORedis from 'ioredis'

// ===========================================================================
// Shared lazy ioredis client. Opened on first use so that merely importing a
// module that touches Redis never opens a connection (matters during
// `next build`, and mirrors the lazy pattern in lib/queue.ts). One connection
// is shared across the rate limiter (lib/ratelimit.ts), response cache
// (lib/api-cache.ts), and the chain locks (lib/locks.ts).
//
// maxRetriesPerRequest: null keeps commands from throwing while Redis is
// briefly unreachable (same setting the locks client has always used).
// ===========================================================================

let client: IORedis | null = null

export function getRedis(): IORedis {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    })
  }
  return client
}
