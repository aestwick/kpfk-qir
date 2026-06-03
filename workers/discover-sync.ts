import { Job } from 'bullmq'
import { supabaseAdmin } from '../lib/supabase'
import { listStationIds, getStation } from '../lib/stations'
import { discoverShows, selectNewShows } from '../lib/archive-discover'
import { getDiscoverySyncEnabled } from '../lib/settings'
import { discoverSyncQueue } from '../lib/queue'

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

  const { data: existingRows, error: existingErr } = await supabaseAdmin
    .from('show_keys')
    .select('key')
    .eq('station_id', stationId)
  if (existingErr) throw new Error(`[discover-sync] failed to load existing keys: ${existingErr.message}`)

  const newShows = selectNewShows(discovered, (existingRows ?? []).map((r) => r.key))
  if (newShows.length === 0) {
    console.log(`[discover-sync] ${station.slug}: ${discovered.length} programs, no new keys`)
    return { discovered: discovered.length, added: 0 }
  }

  // New programs arrive INACTIVE. show_name is seeded from the home-page label;
  // the canonical name + category come from the feed when the show is reviewed/
  // activated (the resolve step), so we leave category null here. ignoreDuplicates
  // makes a concurrent insert a no-op rather than clobbering a curated row.
  const rows = newShows.map((s) => ({
    station_id: stationId,
    key: s.key,
    show_name: s.name,
    active: false,
  }))
  const { error: insertErr } = await supabaseAdmin
    .from('show_keys')
    .upsert(rows, { onConflict: 'station_id,key', ignoreDuplicates: true })
  if (insertErr) throw new Error(`[discover-sync] insert failed: ${insertErr.message}`)

  console.log(`[discover-sync] ${station.slug}: +${newShows.length} new show(s) imported inactive`)
  return { discovered: discovered.length, added: newShows.length }
}
