import IORedis from 'ioredis'

// ===========================================================================
// Per-(station, stage) chain lock — the load-bearing primitive of the
// multi-station sharing model (see "Spec: Multi-Station Sharing & Tenancy" §4.2).
//
// It guarantees a SINGLE active processing chain per station per stage. With the
// expensive stages now running at concurrency ≥ 2, this is what stops one
// station from occupying every worker slot (two of its own chains running at
// once) and starving the others. It also serializes the read-clamp-claim path
// the Layer-B demo allowance will depend on.
//
// This protects the *allocation*. The atomic DB status claim still protects
// *correctness* (no episode processed twice). Do NOT replace this with a
// getActive()+getWaiting() queue scan: that is a check-then-act race and misses
// BullMQ's `delayed` set, where the zero-progress backoff parks jobs.
// ===========================================================================

// Lazy single client, separate from BullMQ's pool, opened on first use (mirrors
// the lazy pattern in lib/queue.ts so importing this never opens a connection).
let client: IORedis | null = null
function redis(): IORedis {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
    })
  }
  return client
}

export type PipelineStage = 'transcribe' | 'summarize' | 'compliance'

const DEFAULT_TTL_MS = 60_000
const REFRESH_EVERY_MS = 20_000

// Compare-and-extend / compare-and-delete: only ever touch a lock we still own,
// so a slow holder whose TTL lapsed can't have its successor's lock stolen.
const EXTEND_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end"
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

function keyFor(stationId: string, stage: PipelineStage): string {
  return `qir:chain-lock:${stage}:${stationId}`
}

/**
 * Run `fn` while holding the exclusive per-(station, stage) lock. If the lock is
 * already held — another chain for this station+stage is draining — `fn` does
 * NOT run and `onBusy` is returned. The skipped job is a clean no-op: the active
 * chain re-queues its own continuation, so no work is lost.
 *
 * The lock auto-refreshes while `fn` runs (a batch can take minutes) and is
 * released on return or throw. A crashed holder's lock expires via TTL, after
 * which the next kick/continue/cron re-acquires and resumes the chain.
 */
export async function withStationStageLock<T, U>(
  stationId: string,
  stage: PipelineStage,
  fn: () => Promise<T>,
  onBusy: U,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T | U> {
  const key = keyFor(stationId, stage)
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`

  const acquired = await redis().set(key, token, 'PX', ttlMs, 'NX')
  if (acquired !== 'OK') return onBusy

  const refresh = setInterval(() => {
    redis()
      .eval(EXTEND_LUA, 1, key, token, String(ttlMs))
      .catch((err) =>
        console.error(`[locks] refresh ${key} failed:`, err instanceof Error ? err.message : err),
      )
  }, REFRESH_EVERY_MS)
  // Don't let the refresh timer keep the process alive on shutdown.
  if (typeof refresh.unref === 'function') refresh.unref()

  try {
    return await fn()
  } finally {
    clearInterval(refresh)
    try {
      await redis().eval(RELEASE_LUA, 1, key, token)
    } catch (err) {
      console.error(`[locks] release ${key} failed:`, err instanceof Error ? err.message : err)
    }
  }
}
