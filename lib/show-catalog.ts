// A station's show catalog for the browse views: feed key → display name and
// logical show (show_group), group → its feed keys. One logical show can span
// several feeds (e.g. a 6am + 9am airing) — always group by show_group, never by
// name (see CLAUDE.md "show_keys"). Pure builder + a thin loader.

import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveShowDisplayName, resolveGroupDisplayName, showGroupKey, type ShowNameFields } from './shows'

export interface CatalogRow extends ShowNameFields {
  category?: string | null
  primary_language?: string | null
  active?: boolean | null
}

export interface CatalogShow {
  /** Normalized group identity (showGroupKey). */
  group: string
  name: string
  keys: string[]
  category: string | null
  active: boolean
}

export interface ShowCatalog {
  /** feed key → its logical show */
  byKey: Map<string, CatalogShow>
  /** group identity → logical show */
  byGroup: Map<string, CatalogShow>
}

export function buildShowCatalog(rows: CatalogRow[], stripPrefixes?: string[] | null): ShowCatalog {
  const feedsByGroup = new Map<string, CatalogRow[]>()
  for (const r of rows) {
    const g = showGroupKey(r)
    const list = feedsByGroup.get(g) ?? []
    list.push(r)
    feedsByGroup.set(g, list)
  }
  const byKey = new Map<string, CatalogShow>()
  const byGroup = new Map<string, CatalogShow>()
  feedsByGroup.forEach((feeds, group) => {
    const show: CatalogShow = {
      group,
      name: resolveGroupDisplayName(feeds, stripPrefixes),
      keys: feeds.map((f) => f.key),
      category: feeds.find((f) => f.category)?.category ?? null,
      active: feeds.some((f) => f.active !== false),
    }
    byGroup.set(group, show)
    for (const f of feeds) byKey.set(f.key, show)
  })
  return { byKey, byGroup }
}

/** Display name for one feed key (falls back to the episode's own show_name). */
export function catalogName(catalog: ShowCatalog, key: string, fallback?: string | null): string {
  return catalog.byKey.get(key)?.name ?? fallback ?? key
}

/** All feed keys of the logical show a key (or group label) belongs to. */
export function groupKeysFor(catalog: ShowCatalog, keyOrGroup: string): string[] {
  const show = catalog.byKey.get(keyOrGroup) ?? catalog.byGroup.get(keyOrGroup.toLowerCase())
  return show ? show.keys : [keyOrGroup]
}

/** Load the catalog for a station (RLS client or service role). */
export async function loadShowCatalog(supabase: SupabaseClient, stationId: string): Promise<ShowCatalog> {
  const [{ data, error }, { data: station }] = await Promise.all([
    supabase
      .from('show_keys')
      .select('key, show_name, feed_name, display_name, show_group, category, active')
      .eq('station_id', stationId),
    supabase.from('stations').select('show_name_strip_prefixes').eq('id', stationId).maybeSingle(),
  ])
  if (error) throw new Error(error.message)
  return buildShowCatalog((data ?? []) as CatalogRow[], station?.show_name_strip_prefixes ?? null)
}

// Re-exported for views that only need a single feed's name.
export { resolveShowDisplayName }
