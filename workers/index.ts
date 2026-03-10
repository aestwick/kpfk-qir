import { Queue, Worker } from 'bullmq'
import { processIngest } from './ingest'
import { processTranscribe } from './transcribe'
import { processSummarize } from './summarize'
import { processCompliance } from './compliance'
import { processGenerateQir } from './generate-qir'
import { processAutoRetry } from './auto-retry'
import { isPipelinePaused, getPipelineMode, type PipelineMode } from '../lib/settings'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

function parseRedisUrl(url: string) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: parseInt(parsed.port) || 6379,
  }
}

const connection = parseRedisUrl(redisUrl)

// Queues (with default job options for retry)
const ingestQueue = new Queue('ingest', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
const transcribeQueue = new Queue('transcribe', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
const summarizeQueue = new Queue('summarize', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
const complianceQueue = new Queue('compliance', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
const generateQirQueue = new Queue('generate-qir', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
  },
})
const autoRetryQueue = new Queue('auto-retry', {
  connection,
  defaultJobOptions: {
    attempts: 1,
  },
})

// Track current pipeline mode for auto-chaining decisions
let currentPipelineMode: PipelineMode = 'surgical'

// -- Ingest Worker --
const ingestWorker = new Worker('ingest', processIngest, {
  connection,
  concurrency: 1,
})

ingestWorker.on('completed', async (job) => {
  const newCount = job.returnvalue?.newEpisodes ?? 0
  console.log(`[ingest] completed — ${newCount} new episodes`)
  // In constant mode, auto-chain to transcription if new episodes found
  if (currentPipelineMode === 'constant' && newCount > 0) {
    console.log('[ingest] constant mode — auto-triggering transcription')
    await transcribeQueue.add('auto-transcribe', {})
  }
})
ingestWorker.on('failed', (job, err) => {
  console.error(`[ingest] failed:`, err.message)
})

// -- Transcribe Worker --
const transcribeWorker = new Worker('transcribe', processTranscribe, {
  connection,
  concurrency: 1,
})

transcribeWorker.on('completed', async (job) => {
  const count = job.returnvalue?.transcribed ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[transcribe] completed — ${count} episodes transcribed${remaining ? ' (more remaining)' : ''}`)

  if (currentPipelineMode === 'constant') {
    // Auto-chain to summarization
    if (count > 0) {
      console.log('[transcribe] constant mode — auto-triggering summarization')
      await summarizeQueue.add('auto-summarize', {})
    }
    // Auto-continue if more to transcribe
    if (remaining) {
      if (count === 0) {
        console.warn('[transcribe] zero progress with remaining episodes — backing off 5 minutes')
        await transcribeQueue.add('transcribe-backoff', {}, { delay: 5 * 60 * 1000 })
      } else {
        await transcribeQueue.add('transcribe-continue', {})
      }
    }
  }
  // In surgical mode: no auto-chain, no auto-continue
})
transcribeWorker.on('failed', (job, err) => {
  console.error(`[transcribe] failed:`, err.message)
})

// -- Summarize Worker --
const summarizeWorker = new Worker('summarize', processSummarize, {
  connection,
  concurrency: 5,
})

summarizeWorker.on('completed', async (job) => {
  const count = job.returnvalue?.summarized ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[summarize] completed — ${count} episodes summarized${remaining ? ' (more remaining)' : ''}`)

  if (currentPipelineMode === 'constant') {
    // Auto-chain to compliance
    if (count > 0) {
      console.log('[summarize] constant mode — auto-triggering compliance')
      await complianceQueue.add('auto-compliance', {})
    }
    // Auto-continue if more to summarize
    if (remaining) {
      if (count === 0) {
        console.warn('[summarize] zero progress with remaining episodes — backing off 5 minutes')
        await summarizeQueue.add('summarize-backoff', {}, { delay: 5 * 60 * 1000 })
      } else {
        await summarizeQueue.add('summarize-continue', {})
      }
    }
  }
  // In surgical mode: no auto-chain, no auto-continue
})
summarizeWorker.on('failed', (job, err) => {
  console.error(`[summarize] failed:`, err.message)
})

// -- Compliance Worker --
const complianceWorker = new Worker('compliance', processCompliance, {
  connection,
  concurrency: 1,
})

complianceWorker.on('completed', async (job) => {
  const count = job.returnvalue?.checked ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[compliance] completed — ${count} episodes checked${remaining ? ' (more remaining)' : ''}`)
  if (currentPipelineMode === 'constant' && remaining) {
    await complianceQueue.add('compliance-continue', {})
  }
  // In surgical mode: no auto-continue
})
complianceWorker.on('failed', (job, err) => {
  console.error(`[compliance] failed:`, err.message)
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

// -- Auto-Retry Worker --
const autoRetryWorker = new Worker('auto-retry', processAutoRetry, {
  connection,
  concurrency: 1,
})

autoRetryWorker.on('completed', async (job) => {
  const { retried, dead } = job.returnvalue ?? {}
  console.log(`[auto-retry] completed — ${retried ?? 0} retried, ${dead ?? 0} moved to dead`)
})
autoRetryWorker.on('failed', (job, err) => {
  console.error(`[auto-retry] failed:`, err.message)
})

// -- Cron Schedules --
let cronActive = false

async function enableCron() {
  if (cronActive) return
  await ingestQueue.add(
    'ingest-cron',
    {},
    { repeat: { pattern: '2 * * * *' } } // minute :02 of every hour
  )
  await autoRetryQueue.add(
    'auto-retry-cron',
    {},
    { repeat: { pattern: '17 */4 * * *' } } // every 4 hours at minute :17
  )
  cronActive = true
  console.log('[cron] enabled — hourly ingest at :02, auto-retry every 4h at :17')
}

async function disableCron() {
  if (!cronActive) return
  const existingIngest = await ingestQueue.getRepeatableJobs()
  for (const job of existingIngest) {
    await ingestQueue.removeRepeatableByKey(job.key)
  }
  const existingRetry = await autoRetryQueue.getRepeatableJobs()
  for (const job of existingRetry) {
    await autoRetryQueue.removeRepeatableByKey(job.key)
  }
  cronActive = false
  console.log('[cron] disabled — no automatic scheduling')
}

// -- Pipeline Mode + Pause Sync --
let currentlyPaused = false

async function syncPipelineState() {
  try {
    // Check pause state
    const paused = await isPipelinePaused()
    if (paused !== currentlyPaused) {
      currentlyPaused = paused
      if (paused) {
        console.log('[workers] pipeline PAUSED — all workers will skip new jobs')
        await Promise.all([
          ingestWorker.pause(),
          transcribeWorker.pause(),
          summarizeWorker.pause(),
          complianceWorker.pause(),
          generateQirWorker.pause(),
        ])
      } else {
        console.log('[workers] pipeline RESUMED — workers accepting jobs again')
        await Promise.all([
          ingestWorker.resume(),
          transcribeWorker.resume(),
          summarizeWorker.resume(),
          complianceWorker.resume(),
          generateQirWorker.resume(),
        ])
      }
    }

    // Check pipeline mode
    const mode = await getPipelineMode()
    if (mode !== currentPipelineMode) {
      console.log(`[workers] pipeline mode changed: ${currentPipelineMode} → ${mode}`)
      currentPipelineMode = mode

      if (mode === 'constant') {
        await enableCron()
      } else {
        await disableCron()
      }
    }
  } catch (err) {
    console.error('[workers] failed to sync pipeline state:', err)
  }
}

// Initialize: read mode, set up accordingly
async function init() {
  const mode = await getPipelineMode()
  currentPipelineMode = mode
  console.log(`[workers] starting in ${mode} mode`)

  if (mode === 'constant') {
    // Clear old crons and set up fresh
    await disableCron()
    await enableCron()
    // Run ingest immediately on startup
    await ingestQueue.add('ingest-startup', {})
    console.log('[workers] startup ingest queued')
  } else {
    // Surgical: clear any leftover crons
    await disableCron()
    console.log('[workers] surgical mode — no automatic scheduling, waiting for manual triggers')
  }
}

init().catch(console.error)

// Sync every 30s
const syncInterval = setInterval(syncPipelineState, 30_000)
// Also sync once on startup (after init)
setTimeout(() => syncPipelineState(), 5_000)

console.log('[workers] all workers started')

// Graceful shutdown
async function shutdown() {
  console.log('[workers] shutting down...')
  clearInterval(syncInterval)
  await Promise.all([
    ingestWorker.close(),
    transcribeWorker.close(),
    summarizeWorker.close(),
    complianceWorker.close(),
    generateQirWorker.close(),
    autoRetryWorker.close(),
  ])
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
