import { supabaseAdmin } from './supabase'
import { Station } from './types'

/**
 * Station lookups for the background workers. Workers run with the service-role
 * client (no user JWT), so the per-station scoping they apply is the ONLY guard
 * against cross-tenant processing — callers must thread the returned station_id
 * into every query.
 */

/** All station ids, for cron fan-out (one job per station per stage). */
export async function listStationIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from('stations').select('id')
  if (error) throw new Error(`Failed to list stations: ${error.message}`)
  return (data ?? []).map((s) => s.id)
}

/** Load a single station's config (rss_base_url, mp3_filename_prefix, etc.). */
export async function getStation(stationId: string): Promise<Station | null> {
  const { data, error } = await supabaseAdmin
    .from('stations')
    .select('*')
    .eq('id', stationId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load station ${stationId}: ${error.message}`)
  return (data as Station | null) ?? null
}
