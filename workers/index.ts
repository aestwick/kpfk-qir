import { Queue, Worker } from 'bullmq'
import { processIngest } from './ingest'
import { processTranscribe } from './transcribe'
import { processSummarize } from './summarize'
import { processCompliance } from './compliance'
import { processGenerateQir } from './generate-qir'
import { processAutoRetry } from './auto-retry'
import { getSetting, isPipelinePaused } from '../lib/settings'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

// -- Pipeline Mode Presets --
const PIPELINE_MODES: Record<string, { transcribe: number; summarize: number }> = {
  steady: { transcribe: 1, summarize: 5 },
  'catch-up': { transcribe: 3, summarize: 10 },
}
const DEFAULT_MODE = 'steady'

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

// -- Ingest Worker --
const ingestWorker = new Worker('ingest', processIngest, {
  connection,
  concurrency: 1,
})

ingestWorker.on('completed', async (job) => {
  const newCount = job.returnvalue?.newEpisodes ?? 0
  console.log(`[ingest] completed — ${newCount} new episodes`)
  // No auto-chain: transcription must be triggered manually from the dashboard
})
ingestWorker.on('failed', (job, err) => {
  console.error(`[ingest] failed:`, err.message)
})

// -- Transcribe Worker --
const initialMode = PIPELINE_MODES[DEFAULT_MODE]
const transcribeWorker = new Worker('transcribe', processTranscribe, {
  connection,
  concurrency: initialMode.transcribe,
})

transcribeWorker.on('completed', async (job) => {
  const count = job.returnvalue?.transcribed ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[transcribe] completed — ${count} episodes transcribed${remaining ? ' (more remaining)' : ''}`)
  // No auto-chain to summarize: must be triggered manually from the dashboard
  if (remaining) {
    if (count === 0) {
      console.warn('[transcribe] zero progress with remaining episodes — backing off 5 minutes')
      await transcribeQueue.add('transcribe-backoff', {}, { delay: 5 * 60 * 1000 })
    } else {
      await transcribeQueue.add('transcribe-continue', {})
    }
  }
})
transcribeWorker.on('failed', (job, err) => {
  console.error(`[transcribe] failed:`, err.message)
})

// -- Summarize Worker --
const summarizeWorker = new Worker('summarize', processSummarize, {
  connection,
  concurrency: initialMode.summarize,
})

summarizeWorker.on('completed', async (job) => {
  const count = job.returnvalue?.summarized ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[summarize] completed — ${count} episodes summarized${remaining ? ' (more remaining)' : ''}`)
  // No auto-chain to compliance: must be triggered manually from the dashboard
  if (remaining) {
    if (count === 0) {
      console.warn('[summarize] zero progress with remaining episodes — backing off 5 minutes')
      await summarizeQueue.add('summarize-backoff', {}, { delay: 5 * 60 * 1000 })
    } else {
      await summarizeQueue.add('summarize-continue', {})
    }
  }
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
  if (remaining) {
    await complianceQueue.add('compliance-continue', {})
  }
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
  // No auto-chain: retried episodes wait in pending until manually triggered
})
autoRetryWorker.on('failed', (job, err) => {
  console.error(`[auto-retry] failed:`, err.message)
})

// -- Cron Schedules --
async function setupCron() {
  // Remove any existing repeatable jobs first
  const existingIngest = await ingestQueue.getRepeatableJobs()
  for (const job of existingIngest) {
    await ingestQueue.removeRepeatableByKey(job.key)
  }
  const existingRetry = await autoRetryQueue.getRepeatableJobs()
  for (const job of existingRetry) {
    await autoRetryQueue.removeRepeatableByKey(job.key)
  }

  await ingestQueue.add(
    'ingest-cron',
    {},
    {
      repeat: { pattern: '2 * * * *' }, // minute :02 of every hour
    }
  )

  await autoRetryQueue.add(
    'auto-retry-cron',
    {},
    {
      repeat: { pattern: '17 */4 * * *' }, // every 4 hours at minute :17
    }
  )

  console.log('[cron] hourly ingest scheduled at minute :02')
  console.log('[cron] auto-retry scheduled every 4 hours at minute :17')
}

setupCron().catch(console.error)

// Run ingest immediately on startup
ingestQueue.add('ingest-startup', {}).then(() => {
  console.log('[workers] startup ingest queued')
}).catch(console.error)

// -- Pipeline Mode Polling --
let currentMode = DEFAULT_MODE
let currentlyPaused = false

async function syncPipelineMode() {
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

    // Check mode (only matters when not paused)
    const mode = (await getSetting<string>('pipeline_mode')) ?? DEFAULT_MODE
    const preset = PIPELINE_MODES[mode]
    if (!preset) return
    if (mode !== currentMode) {
      transcribeWorker.concurrency = preset.transcribe
      summarizeWorker.concurrency = preset.summarize
      console.log(`[workers] pipeline mode changed: ${currentMode} → ${mode} (transcribe=${preset.transcribe}, summarize=${preset.summarize})`)
      currentMode = mode
    }
  } catch (err) {
    console.error('[workers] failed to sync pipeline mode:', err)
  }
}

// Check on startup, then every 30s
syncPipelineMode()
const modeInterval = setInterval(syncPipelineMode, 30_000)

console.log('[workers] all workers started')

// Graceful shutdown
async function shutdown() {
  console.log('[workers] shutting down...')
  clearInterval(modeInterval)
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
