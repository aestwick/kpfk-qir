import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { listStationIds } from '../lib/stations'
import { isPipelinePaused } from '../lib/settings'
import { correctionsQueue } from '../lib/queue'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'
import { backfillPendingCorrections } from '../lib/transcription/repair'
import { syncCmsHosts, mineSuggestions } from '../lib/transcription/miner'

/**
 * Transcript-name upkeep. Job data: `{ stationId?, task }`.
 *
 *   task 'backfill' — re-apply pending correction rules (backfilled_at null) to
 *     that station's STORED transcripts. Enqueued by the corrections API when a
 *     rule is created, edited or approved, and once per station on startup (so
 *     the pre-approved existing rules apply right after deploy).
 *   task 'nightly'  — sync new website hosts into the name list, mine suggested
 *     corrections (queued for human approval, never applied), then backfill.
 *
 * Without a stationId the job is a dispatcher (cron/startup) and fans out one
 * job per station. Honors the pipeline pause (global OR station).
 */
export async function processCorrections(job: Job) {
  const task = (job.data?.task as 'backfill' | 'nightly' | undefined) ?? 'backfill'
  const stationId = job.data?.stationId as string | undefined

  if (!stationId) {
    const ids = await listStationIds()
    for (const id of ids) {
      await correctionsQueue.add(`corrections-${task}`, { stationId: id, task })
    }
    return { dispatched: ids.length, task }
  }

  if (await isPipelinePaused(stationId)) {
    return { skipped: 'paused' as const, task }
  }

  // Upkeep steps are independent: a miner or CMS-sync failure must never
  // stop the backfill of rules a person already approved.
  let cmsAdded = 0
  let mined: Awaited<ReturnType<typeof mineSuggestions>> | null = null
  const errors: string[] = []
  if (task === 'nightly') {
    try {
      cmsAdded = await syncCmsHosts(supabaseAdmin, stationId)
    } catch (err) {
      errors.push(`cms sync: ${err instanceof Error ? err.message : err}`)
    }
    try {
      mined = await mineSuggestions(supabaseAdmin, stationId)
    } catch (err) {
      errors.push(`miner: ${err instanceof Error ? err.message : err}`)
    }
    for (const e of errors) console.warn(`[corrections] station ${stationId} ${e}`)
  }

  const r = await backfillPendingCorrections(supabaseAdmin, stationId, { apply: true })
  const changed = r.changedEpisodes
  const reembedded = r.reembeddedEpisodes
  const stamped = r.stampedRules
  const skippedSelfReapplying = r.skippedSelfReapplying

  if (changed || stamped.length || cmsAdded || mined?.queued) {
    void logAuditEvent({
      action: task === 'nightly' ? AUDIT_ACTIONS.CORRECTIONS_NIGHTLY : AUDIT_ACTIONS.CORRECTIONS_BACKFILL,
      operation: 'update',
      stationId,
      resourceType: 'transcript',
      metadata: {
        changedEpisodes: changed,
        reembeddedEpisodes: reembedded,
        rulesBackfilled: stamped,
        skippedSelfReapplying,
        errors,
        cmsHostsAdded: cmsAdded,
        suggestionsQueued: mined?.queued ?? 0,
        suggestionsUpdated: mined?.updated ?? 0,
      },
    })
  }
  return { task, changedEpisodes: changed, reembedded, rulesBackfilled: stamped.length, cmsAdded, mined, errors }
}
