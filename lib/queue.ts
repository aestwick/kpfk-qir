import { Queue } from 'bullmq'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

function parseRedisUrl(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port) || 6379,
  }
}

const connectionConfig = parseRedisUrl(redisUrl)

export const ingestQueue = new Queue('ingest', {
  connection: connectionConfig,
  defaultJobOptions: {
    timeout: 5 * 60 * 1000,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
export const transcribeQueue = new Queue('transcribe', {
  connection: connectionConfig,
  defaultJobOptions: {
    timeout: 10 * 60 * 1000,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
export const summarizeQueue = new Queue('summarize', {
  connection: connectionConfig,
  defaultJobOptions: {
    timeout: 2 * 60 * 1000,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
export const generateQirQueue = new Queue('generate-qir', {
  connection: connectionConfig,
  defaultJobOptions: {
    timeout: 5 * 60 * 1000,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
export const autoRetryQueue = new Queue('auto-retry', {
  connection: connectionConfig,
  defaultJobOptions: {
    timeout: 2 * 60 * 1000,
    attempts: 1,
  },
})
