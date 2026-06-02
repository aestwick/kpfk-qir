import { Queue, Worker } from 'bullmq'
import { processIngest } from './ingest'
import { processTranscribe } from './transcribe'
import { processSummarize } from './summarize'
import { processCompliance } from './compliance'
import { processGenerateQir } from './generate-qir'
import { processAutoRetry } from './auto-retry'
import { isPipelinePaused } from '../lib/settings'
import { jobPriority } from '../lib/tier'

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

// -- Fixed worker concurrency --
// The steady/catch-up mode toggle was throughput theater (the pipeline is
// I/O-bound on Groq + archive bandwidth, which local concurrency can't raise).
// A fixed floor ≥ 2 on the expensive stages is for *isolation*, not speed: at 1,
// one station head-of-line-blocks KPFK. Production-first ordering comes from
// BullMQ job priority (lib/tier.ts); the per-(station,stage) lock (lib/locks.ts)
// keeps any one station to a single chain so it can't occupy both slots.
const TRANSCRIBE_CONCURRENCY = 2
const SUMMARIZE_CONCURRENCY = 5

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
  // Auto-chain: new episodes flow straight into transcription, which cascades on
  // through summarize → compliance. Skipped while the pipeline is paused (the
  // station-level job carries stationId; the cron fan-out tick does not).
  const stationId = job.data?.stationId
  if (newCount > 0 && stationId && !(await isPipelinePaused(stationId))) {
    console.log('[ingest] auto-chain → transcribe')
    await transcribeQueue.add('chain-transcribe', { stationId, source: 'chain', chain: true }, { priority: await jobPriority(stationId) })
  }
})
ingestWorker.on('failed', (job, err) => {
  console.error(`[ingest] failed:`, err.message)
})

// -- Transcribe Worker --
const transcribeWorker = new Worker('transcribe', processTranscribe, {
  connection,
  concurrency: TRANSCRIBE_CONCURRENCY,
})

transcribeWorker.on('completed', async (job) => {
  const stationId = job.data?.stationId
  const priority = await jobPriority(stationId)
  const count = job.returnvalue?.transcribed ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[transcribe] completed — ${count} episodes transcribed${remaining ? ' (more remaining)' : ''}`)
  if (remaining) {
    if (count === 0) {
      console.warn('[transcribe] zero progress with remaining episodes — backing off 5 minutes')
      await transcribeQueue.add('transcribe-backoff', { stationId }, { delay: 5 * 60 * 1000, priority })
    } else {
      await transcribeQueue.add('transcribe-continue', { stationId, ...(job.data?.chain ? { source: job.data.source, chain: true } : {}) }, { priority })
    }
  }
  // Auto-chain to summarize when part of a cascade (audit or pipeline chain).
  // Skipped while paused so a resumed pipeline doesn't fan out stale work.
  if ((job.data?.source === 'audit' || job.data?.source === 'chain') && job.data?.chain && count > 0 && !(await isPipelinePaused(job.data?.stationId))) {
    console.log(`[transcribe] ${job.data.source} auto-chain → summarize`)
    await summarizeQueue.add('chain-summarize', { stationId, source: job.data.source, chain: true }, { priority })
  }
})
transcribeWorker.on('failed', (job, err) => {
  console.error(`[transcribe] failed:`, err.message)
})

// -- Summarize Worker --
const summarizeWorker = new Worker('summarize', processSummarize, {
  connection,
  concurrency: SUMMARIZE_CONCURRENCY,
})

summarizeWorker.on('completed', async (job) => {
  const stationId = job.data?.stationId
  const priority = await jobPriority(stationId)
  const count = job.returnvalue?.summarized ?? 0
  const remaining = job.returnvalue?.remaining ?? false
  console.log(`[summarize] completed — ${count} episodes summarized${remaining ? ' (more remaining)' : ''}`)
  if (remaining) {
    if (count === 0) {
      console.warn('[summarize] zero progress with remaining episodes — backing off 5 minutes')
      await summarizeQueue.add('summarize-backoff', { stationId }, { delay: 5 * 60 * 1000, priority })
    } else {
      await summarizeQueue.add('summarize-continue', { stationId, ...(job.data?.chain ? { source: job.data.source, chain: true } : {}) }, { priority })
    }
  }
  // Auto-chain to compliance/QIR when part of a cascade (audit or pipeline chain).
  // This is the final automated stage — episodes get compliance-checked without a
  // manual trigger. Skipped while paused.
  if ((job.data?.source === 'audit' || job.data?.source === 'chain') && job.data?.chain && count > 0 && !(await isPipelinePaused(job.data?.stationId))) {
    console.log(`[summarize] ${job.data.source} auto-chain → compliance`)
    await complianceQueue.add('chain-compliance', { stationId, source: job.data.source }, { priority })
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
    await complianceQueue.add('compliance-continue', { stationId: job.data?.stationId }, { priority: await jobPriority(job.data?.stationId) })
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

// Recover episodes orphaned mid-stage (transcribing/summarizing) by a prior crash
// or restart. recoverAll resets them immediately since no worker is running yet.
autoRetryQueue.add('auto-retry-startup', { recoverAll: true }).then(() => {
  console.log('[workers] startup orphan recovery queued')
}).catch(console.error)

// Run ingest immediately on startup
ingestQueue.add('ingest-startup', {}).then(() => {
  console.log('[workers] startup ingest queued')
}).catch(console.error)

// -- Pause Polling --
// pipeline_paused is the global kill switch (toggled from the dashboard). Poll it
// and pause/resume every worker to match. The steady/catch-up mode toggle was
// removed — concurrency is fixed (see the constants near the top).
let currentlyPaused = false

async function syncPipelinePause() {
  try {
    // GLOBAL master pause only (no stationId) — this is the one signal that can
    // BullMQ-pause the shared worker pool wholesale. Per-station pause can't pause
    // the shared pool, so it's enforced inside the dispatcher/chain/processors via
    // isPipelinePaused(stationId); it never reaches here.
    const paused = await isPipelinePaused()
    if (paused === currentlyPaused) return
    currentlyPaused = paused
    if (paused) {
      console.log('[workers] pipeline PAUSED (global) — all workers will skip new jobs')
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
  } catch (err) {
    console.error('[workers] failed to sync pause state:', err)
  }
}

// Check on startup, then every 30s
syncPipelinePause()
const pauseInterval = setInterval(syncPipelinePause, 30_000)

console.log('[workers] all workers started')

// Graceful shutdown
async function shutdown() {
  console.log('[workers] shutting down...')
  clearInterval(pauseInterval)
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
