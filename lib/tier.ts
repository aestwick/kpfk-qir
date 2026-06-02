import { supabaseAdmin } from './supabase'

// ===========================================================================
// Station tier → scheduling priority (see "Spec: Multi-Station Sharing" §2/§4.4).
//
//   production — KPFK: right of way, unmetered
//   paying     — subscribed peer: fair-share, unmetered
//   demo       — prospect on a time-boxed trial: capped (Layer B)
//   test       — internal/manual trial: lowest priority
//
// Priority is *work-conserving*: KPFK simply goes first when it has work; when
// it's idle (most of the quarter) the lower tiers get the whole pipe. The tier
// also retires the implicit "test = no rss_base_url" signal.
// ===========================================================================

export type StationTier = 'production' | 'paying' | 'demo' | 'test'

// Lower number = higher BullMQ priority (dequeued first). Every expensive-stage
// job is given an explicit priority so the queue's priority set stays totally
// ordered across stations.
const TIER_PRIORITY: Record<StationTier, number> = {
  production: 1,
  paying: 2,
  demo: 3,
  test: 3,
}
const DEFAULT_PRIORITY = TIER_PRIORITY.test

// Tier changes rarely (an admin flip) but this is read on every stage enqueue,
// so cache it with the same 60s TTL lib/settings.ts uses.
const cache = new Map<string, { tier: StationTier; at: number }>()
const TTL_MS = 60_000

export async function getStationTier(stationId: string): Promise<StationTier> {
  const hit = cache.get(stationId)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tier
  // Until migration 029 is applied the column is absent; the query errors and we
  // fall back to 'test' — i.e. every station gets equal priority, exactly today's
  // behaviour. Safe to ship the code ahead of the migration.
  const { data } = await supabaseAdmin
    .from('stations')
    .select('tier')
    .eq('id', stationId)
    .maybeSingle()
  const tier = ((data?.tier as StationTier | undefined) ?? 'test')
  cache.set(stationId, { tier, at: Date.now() })
  return tier
}

/** BullMQ `priority` for a station's expensive-stage jobs (lower = sooner). */
export async function jobPriority(stationId: string | undefined): Promise<number> {
  if (!stationId) return DEFAULT_PRIORITY
  return TIER_PRIORITY[await getStationTier(stationId)] ?? DEFAULT_PRIORITY
}
