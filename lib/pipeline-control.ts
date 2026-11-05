import { ingestQueue, transcribeQueue, summarizeQueue, complianceQueue } from '@/lib/queue'
import { supabaseAdmin } from '@/lib/supabase'
import { invalidateSetting } from '@/lib/settings'

/**
 * Pipeline pause + failed-job controls, shared by the super-admin Master
 * Control (app/api/admin/overview) and the station Processing-queue API
 * (app/api/jobs) so both write the same rows the same way. Server-only
 * (service-role client + BullMQ). Callers do their own authorization.
 */

export const PIPELINE_QUEUES = {
  ingest: ingestQueue,
  transcribe: transcribeQueue,
  summarize: summarizeQueue,
  compliance: complianceQueue,
}
export type PipelineQueueName = keyof typeof PIPELINE_QUEUES

export function isPipelineQueueName(name: unknown): name is PipelineQueueName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(PIPELINE_QUEUES, name)
}

/** GLOBAL kill switch (qir_settings.pipeline_paused) — every station. */
export async function setGlobalPaused(paused: boolean): Promise<void> {
  const { error } = await supabaseAdmin
    .from('qir_settings')
    .upsert({ key: 'pipeline_paused', value: JSON.stringify(paused), updated_at: new Date().toISOString() }, { onConflict: 'key' })
  if (error) throw error
  invalidateSetting('pipeline_paused')
}

/** One station's own pause flag (station_settings). Other stations are untouched. */
export async function setStationPaused(stationId: string, paused: boolean): Promise<void> {
  const { error } = await supabaseAdmin
    .from('station_settings')
    .upsert(
      { station_id: stationId, key: 'pipeline_paused', value: JSON.stringify(paused), updated_at: new Date().toISOString() },
      { onConflict: 'station_id,key' }
    )
  if (error) throw error
  invalidateSetting('pipeline_paused')
}

/**
 * Retry or remove failed BullMQ jobs. The queues are SHARED by every station,
 * so pass `stationId` to touch only jobs whose data.stationId matches; omit it
 * (super-admin Master Control only) to sweep every station. Jobs without a
 * stationId (e.g. the cron dispatcher) are only reached by an unscoped sweep.
 * Returns how many jobs were acted on.
 */
export async function sweepFailedJobs(opts: {
  action: 'retry' | 'clear'
  queues?: PipelineQueueName[]
  stationId?: string
}): Promise<number> {
  const targets = opts.queues ?? (Object.keys(PIPELINE_QUEUES) as PipelineQueueName[])
  let count = 0
  for (const name of targets) {
    const failed = await PIPELINE_QUEUES[name].getFailed(0, 1000)
    const scoped = opts.stationId ? failed.filter((j) => j.data?.stationId === opts.stationId) : failed
    for (const job of scoped) {
      try {
        if (opts.action === 'retry') await job.retry()
        else await job.remove()
        count++
      } catch {
        // Job may have been removed or already retried — skip.
      }
    }
  }
  return count
}
