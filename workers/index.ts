import { Queue, Worker } from 'bullmq'
import { processIngest } from './ingest'
import { processTranscribe } from './transcribe'
import { processSummarize } from './summarize'
import { processGenerateQir } from './generate-qir'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

function parseRedisUrl(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port) || 6379,
  }
}

const connection = parseRedisUrl(redisUrl)

// Queues
const ingestQueue = new Queue('ingest', { connection })
const transcribeQueue = new Queue('transcribe', { connection })
const summarizeQueue = new Queue('summarize', { connection })
const generateQirQueue = new Queue('generate-qir', { connection })

// -- Ingest Worker --
const ingestWorker = new Worker('ingest', processIngest, {
  connection,
  concurrency: 1,
})

ingestWorker.on('completed', async (job) => {
  const newCount = job.returnvalue?.newEpisodes ?? 0
  console.log(`[ingest] completed — ${newCount} new episodes`)
  if (newCount > 0) {
    await transcribeQueue.add('transcribe-batch', {})
  }
})
ingestWorker.on('failed', (job, err) => {
  console.error(`[ingest] failed:`, err.message)
})

// -- Transcribe Worker --
const transcribeWorker = new Worker('transcribe', processTranscribe, {
  connection,
  concurrency: 1, // ffmpeg is heavy, run one at a time
})

transcribeWorker.on('completed', async (job) => {
  const count = job.returnvalue?.transcribed ?? 0
  console.log(`[transcribe] completed — ${count} episodes transcribed`)
  if (count > 0) {
    await summarizeQueue.add('summarize-batch', {})
  }
})
transcribeWorker.on('failed', (job, err) => {
  console.error(`[transcribe] failed:`, err.message)
})

// -- Summarize Worker --
const summarizeWorker = new Worker('summarize', processSummarize, {
  connection,
  concurrency: 3,
})

summarizeWorker.on('completed', (job) => {
  const count = job.returnvalue?.summarized ?? 0
  console.log(`[summarize] completed — ${count} episodes summarized`)
})
summarizeWorker.on('failed', (job, err) => {
  console.error(`[summarize] failed:`, err.message)
})

// -- Generate QIR Worker --
const generateQirWorker = new Worker('generate-qir', processGenerateQir, {
  connection,
  concurrency: 1,
})

generateQirWorker.on('completed', (job) => {
  const result = job.returnvalue
  console.log(`[generate-qir] completed —`, result)
})
generateQirWorker.on('failed', (job, err) => {
  console.error(`[generate-qir] failed:`, err.message)
})

// -- Hourly Ingest Cron (minute :02) --
async function setupCron() {
  // Remove any existing repeatable jobs first
  const existing = await ingestQueue.getRepeatableJobs()
  for (const job of existing) {
    await ingestQueue.removeRepeatableByKey(job.key)
  }

  await ingestQueue.add(
    'ingest-cron',
    {},
    {
      repeat: { pattern: '2 * * * *' }, // minute :02 of every hour
    }
  )
  console.log('[cron] hourly ingest scheduled at minute :02')
}

setupCron().catch(console.error)

console.log('[workers] all workers started')

// Graceful shutdown
async function shutdown() {
  console.log('[workers] shutting down...')
  await Promise.all([
    ingestWorker.close(),
    transcribeWorker.close(),
    summarizeWorker.close(),
    generateQirWorker.close(),
  ])
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
