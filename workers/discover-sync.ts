import { Job } from 'bullmq'
import { supabaseAdmin, stationScoped } from '../lib/supabase'
import { listStationIds, getStation } from '../lib/stations'
import { discoverShows, selectNewShows } from '../lib/archive-discover'
import { resolveShowKeys } from '../lib/shows-resolve'
import { getDiscoverySyncEnabled } from '../lib/settings'
import { discoverSyncQueue } from '../lib/queue'
import { logAuditEvent, AUDIT_ACTIONS } from '../lib/audit'

/**
 * Scheduled archive show-key sync. The cron/startup tick (no stationId) fans out
 * one job per station; each station job reads its archive home page program list
 * (lib/archive-discover) and inserts any program not already in show_keys.
 *
 * Opt-out model: every program is imported automatically — but INACTIVE, so it
 * sits for review and never pulls/processes until an operator activates it (the
 * active gate is what keeps Música/Español and duplicates out of the pipeline).
 * Existing/curated rows are never modified; only genuinely new keys are inserted.
 *
 * Not gated on the global pause flag: importing inactive metadata costs nothing
 * and pulls nothing, and gating it would silently stop peer onboarding whenever
 * KPFK is paused.
 */
/**
 * Fill <category> on show_keys rows that never resolved one. Bounded to rows
 * where category IS NULL, and the UPDATE re-asserts that guard so a value set
 * concurrently (or any curated category) is never clobbered. The read side is
 * one archive feed fetch per uncategorized key (resolveShowKeys paces them in
 * bounded batches), which is why this is an explicit operator-triggered job and
 * not folded into the recurring sync. A feed that exposes no <category> simply
 * stays null (re-checked only on the next manual backfill).
 */
async function backfillNullCategories(stationId: string, slug: string, rssBaseUrl: string) {
  const { data: rows, error } = await stationScoped(
    supabaseAdmin.from('show_keys').select('key'),
    stationId,
  ).is('category', null)
  if (error) throw new Error(`[discover-sync] backfill: failed to load uncategorized keys: ${error.message}`)
  if (!rows || rows.length === 0) {
    console.log(`[discover-sync] ${slug}: no uncategorized shows to backfill`)
    return { mode: 'backfill', attempted: 0, backfilled: 0 }
  }

  const resolved = await resolveShowKeys(rssBaseUrl, rows.map((r) => r.key))
  let backfilled = 0
  for (const r of resolved) {
    if (!r.ok || !r.category) continue
    const { error: upErr } = await stationScoped(
      supabaseAdmin.from('show_keys').update({ category: r.category }),
      stationId,
    )
      .eq('key', r.key)
      .is('category', null)
    if (upErr) {
      console.warn(`[discover-sync] backfill: failed to set category for ${r.key}: ${upErr.message}`)
      continue
    }
    backfilled++
  }

  console.log(`[discover-sync] ${slug}: backfilled category on ${backfilled}/${rows.length} uncategorized show(s)`)
  void logAuditEvent({
    action: AUDIT_ACTIONS.DISCOVERY_SYNC_COMPLETE,
    operation: 'update',
    stationId,
    resourceType: 'show_key',
    metadata: { mode: 'backfill-categories', attempted: rows.length, backfilled },
  })
  return { mode: 'backfill', attempted: rows.length, backfilled }
}

export async function processDiscoverSync(job: Job) {
  const stationId = job.data?.stationId as string | undefined

  // Cron/startup tick: dispatch one sync job per station.
  if (!stationId) {
    const ids = await listStationIds()
    for (const id of ids) {
      await discoverSyncQueue.add('discover-sync-station', { stationId: id })
    }
    console.log(`[discover-sync] dispatched for ${ids.length} station(s)`)
    return { dispatched: ids.length }
  }

  const station = await getStation(stationId)
  if (!station) throw new Error(`[discover-sync] station ${stationId} not found`)

  // Explicit operator action (job.data.backfill): re-resolve and fill <category>
  // on existing rows that never got one — e.g. shows added via the manual
  // "Discover from archive" path, which carries key+name only and skips the
  // resolve step. Runs independent of the discovery_sync_enabled gate since it's
  // manually invoked, and only fills NULLs (a curated category is never touched).
  if (job.data?.backfill) {
    if (!station.rss_base_url) {
      console.warn(`[discover-sync] backfill: ${station.slug} has no rss_base_url — skipping`)
      return { mode: 'backfill', skipped: 'no rss_base_url' }
    }
    return await backfillNullCategories(stationId, station.slug, station.rss_base_url)
  }

  if (!(await getDiscoverySyncEnabled(stationId))) {
    console.log(`[discover-sync] disabled for ${station.slug} — skipping`)
    return { skipped: 'disabled' }
  }
  // rss_base_url is required to locate the archive. Skip visibly (not silently)
  // for stations that haven't been configured yet.
  if (!station.rss_base_url) {
    console.warn(`[discover-sync] station ${station.slug} has no rss_base_url — skipping`)
    return { skipped: 'no rss_base_url' }
  }

  // One home-page fetch returns the station's whole program list.
  const discovered = await discoverShows(station.rss_base_url)
  if (discovered.length === 0) {
    // Page loaded but parsed to zero programs — surface it (likely a markup
    // change), never treat as a valid "no programs" success.
    console.warn(`[discover-sync] ${station.slug}: zero programs parsed from archive home page`)
    return { discovered: 0, added: 0 }
  }

  const { data: existingRows, error: existingErr } = await stationScoped(
    supabaseAdmin.from('show_keys').select('key'),
    stationId,
  )
  if (existingErr) throw new Error(`[discover-sync] failed to load existing keys: ${existingErr.message}`)

  const newShows = selectNewShows(discovered, (existingRows ?? []).map((r) => r.key))
  if (newShows.length === 0) {
    console.log(`[discover-sync] ${station.slug}: ${discovered.length} programs, no new keys`)
    return { discovered: discovered.length, added: 0 }
  }

  // Resolve each NEW key's feed for its real <category> (and canonical title). The
  // category is load-bearing: it's what the ingest/transcribe exclusion list matches
  // (Música/Español/...). Without it, a show activated before its category is set
  // would silently bypass that exclusion. Bounded to new keys only, so steady-state
  // cost is ~zero; a station's first sync resolves its whole list once.
  const resolved = await resolveShowKeys(station.rss_base_url, newShows.map((s) => s.key))
  const byKey = new Map(resolved.map((r) => [r.key, r]))

  // New programs arrive INACTIVE. ignoreDuplicates makes a concurrent insert a
  // no-op rather than clobbering a curated row. A feed that didn't resolve keeps
  // the home-page name and a null category (visible for review).
  const rows = newShows.map((s) => {
    const r = byKey.get(s.key)
    return {
      station_id: stationId,
      key: s.key,
      show_name: r?.feed_name ?? s.name,
      category: r?.category ?? null,
      active: false,
    }
  })
  const { error: insertErr } = await supabaseAdmin
    .from('show_keys')
    .upsert(rows, { onConflict: 'station_id,key', ignoreDuplicates: true })
  if (insertErr) throw new Error(`[discover-sync] insert failed: ${insertErr.message}`)

  console.log(`[discover-sync] ${station.slug}: +${newShows.length} new show(s) imported inactive`)
  // System audit event, mirroring ingest (only when work happened).
  void logAuditEvent({
    action: AUDIT_ACTIONS.DISCOVERY_SYNC_COMPLETE,
    operation: 'insert',
    stationId,
    resourceType: 'show_key',
    metadata: { discovered: discovered.length, added: newShows.length },
  })
  return { discovered: discovered.length, added: newShows.length }
}
