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

export const ingestQueue = new Queue('ingest', { connection: connectionConfig })
export const transcribeQueue = new Queue('transcribe', { connection: connectionConfig })
export const summarizeQueue = new Queue('summarize', { connection: connectionConfig })
