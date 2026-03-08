import { Queue } from 'bullmq'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

function parseRedisUrl(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port) || 6379,
  }
}

const defaultJobOptions = {
  attempts: 2,
  backoff: { type: 'exponential' as const, delay: 5000 },
}

// Lazy-initialize queues to avoid Redis connections during next build.
// Uses the same Proxy pattern as lib/supabase.ts.
function lazyQueue(name: string, jobOptions?: Record<string, unknown>): Queue {
  let instance: Queue | null = null
  return new Proxy({} as Queue, {
    get(_target, prop) {
      if (!instance) {
        instance = new Queue(name, {
          connection: parseRedisUrl(redisUrl),
          defaultJobOptions: jobOptions ?? defaultJobOptions,
        })
      }
      return (instance as any)[prop]
    },
  })
}

export const ingestQueue = lazyQueue('ingest')
export const transcribeQueue = lazyQueue('transcribe')
export const summarizeQueue = lazyQueue('summarize')
export const generateQirQueue = lazyQueue('generate-qir')
export const complianceQueue = lazyQueue('compliance')
export const autoRetryQueue = lazyQueue('auto-retry', { attempts: 1 })
