import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { isPipelinePaused } from '../lib/settings'
import { confessorResyncQueue } from '../lib/queue'
import { resyncConfessor } from '../lib/confessor-resync'

/**
 * Nightly Confessor re-sync: pull producers' after-air edits (guests filled in,
 * spellings fixed, issue tags added) onto episodes ingest already saw. Logic and
 * safety rules live in lib/confessor-resync.ts; the CLI twin is
 * scripts/resync-confessor.ts.
 *
 * Without a stationId the job is a dispatcher (cron) and fans out one job per
 * station that has a Confessor host. 60 days = Confessor's own `fil` window, so
 * every episode still re-readable is re-read every night. Episodes whose
 * resolved host/guest moved are re-summarized (lib docs explain why only those).
 */
export const RESYNC_DAYS = 60
/** Rows asked of Confessor per show: a daily show airs ~60 times in 60 days. */
const RESYNC_NUM = 75

export async function processConfessorResync(job: Job) {
  const stationId = job.data?.stationId as string | undefined

  if (!stationId) {
    const { data, error } = await supabaseAdmin
      .from('stations')
      .select('id')
      .not('confessor_base_url', 'is', null)
    if (error) throw new Error(`Failed to list Confessor stations: ${error.message}`)
    for (const s of data ?? []) {
      await confessorResyncQueue.add('confessor-resync-station', { stationId: s.id })
    }
    return { dispatched: (data ?? []).length }
  }

  // Re-summarize spends money; honor the pause (global OR this station).
  if (await isPipelinePaused(stationId)) return { skipped: 'paused' as const }

  const r = await resyncConfessor(stationId, {
    days: RESYNC_DAYS,
    num: RESYNC_NUM,
    apply: true,
    resummarize: true,
    trigger: 'cron',
  })

  const summary = {
    station: r.station.slug,
    matched: r.matched,
    changed: r.changes.length,
    written: r.written,
    resummarized: r.resummarized.length,
    conflicts: r.conflicts.length,
    failures: r.failures.length,
    failedShows: r.failedShows.length,
  }
  // A whole-run failure (every show unreadable, or writes failing) should show
  // as a failed job, not a quiet success. One or two flaky shows should not.
  if (r.failures.length || (r.showsRead > 0 && r.failedShows.length === r.showsRead)) {
    throw new Error(`confessor-resync ${r.station.slug}: ${JSON.stringify(summary)}`)
  }
  return summary
}
