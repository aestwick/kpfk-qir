/**
 * Bulk transcript dump by show.
 *
 * Pulls every transcribed episode whose episode_log.show_name matches one of the
 * SHOW_PATTERNS below (KPFK only), and writes:
 *
 *   transcript-dump/<Show_Name>/<air_date>_<episode_id>.txt   one file per airing
 *   transcript-dump/manifest.csv                              index of everything written
 *
 * Anchored on episode_log.show_name (not show_keys) on purpose: the real data
 * lives under the "KPFK - ..." keys, the curated show_keys list is full of
 * zero-episode duplicates, and several requested labels only exist as episode
 * show_names. Matching the episode's own name collapses all feed variants
 * (e.g. every "Something's Happening A/B hour N") in one pass.
 *
 * Usage:
 *   npx tsx scripts/dump-transcripts.ts            # original-language transcript
 *   npx tsx scripts/dump-transcripts.ts --english  # english_transcript when present
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the env
 * (same vars the workers use).
 */
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { supabaseAdmin } from '../lib/supabase'

// lowercased ILIKE patterns, matched against episode_log.show_name
const SHOW_PATTERNS = [
  '%hartmann%', '%global village%', '%law and disorder%', '%background briefing%',
  '%democracy now%', "%something's happening%", '%gary baca%', '%rhapsody in black%',
  '%qr code%', '%mitch jeserich%', '%unattributed web pledge%', '%maggie%black history%',
  '%cut to the chase%', '%lisa garr%', '%cary harri%', '%dark star%',
  '%gospel classics%', '%roots music%', '%miscellaneous%', '%reggae central%',
  '%folkscene%', '%maggie%makeba%', '%la raza radio%', '%alan watts%',
  '%think outside the cage%',
]

const STATION_SLUG = 'kpfk'
const OUT_DIR = join(process.cwd(), 'transcript-dump')
const useEnglish = process.argv.includes('--english')
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown'

async function main() {
  const { data: station, error: stErr } = await supabaseAdmin
    .from('stations').select('id').eq('slug', STATION_SLUG).single()
  if (stErr || !station) throw new Error(`station ${STATION_SLUG} not found: ${stErr?.message}`)
  const stationId = station.id

  // 1) candidate episodes: transcribed/summarized, name matches any pattern
  const orFilter = SHOW_PATTERNS.map((p) => `show_name.ilike.${p}`).join(',')
  const { data: episodes, error: epErr } = await supabaseAdmin
    .from('episode_log')
    .select('id, show_name, show_key, air_date, air_start')
    .eq('station_id', stationId)
    .in('status', ['transcribed', 'summarized', 'compliance_checked'])
    .or(orFilter)
    .order('show_name', { ascending: true })
    .order('air_date', { ascending: true })
  if (epErr) throw epErr
  if (!episodes?.length) { console.log('No matching episodes.'); return }
  console.log(`Matched ${episodes.length} episodes. Fetching transcripts...`)

  // 2) fetch transcripts in chunks (cells are large — keep payloads sane)
  const field = useEnglish ? 'english_transcript' : 'transcript'
  const byEp = new Map<number, string | null>()
  const ids = episodes.map((e) => e.id)
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    const { data, error } = await supabaseAdmin
      .from('transcripts')
      .select(`episode_id, transcript, english_transcript`)
      .in('episode_id', batch)
    if (error) throw error
    for (const t of data ?? []) {
      byEp.set(t.episode_id, (t as any)[field] ?? (useEnglish ? t.transcript : null))
    }
    process.stdout.write(`\r  ${Math.min(i + 50, ids.length)}/${ids.length}`)
  }
  console.log('')

  // 3) write per-show files + manifest
  mkdirSync(OUT_DIR, { recursive: true })
  const manifest: string[] = ['show_name,air_date,air_start,episode_id,file,chars']
  let written = 0, empty = 0
  for (const ep of episodes) {
    const text = byEp.get(ep.id)
    if (!text) { empty++; continue }
    const showDir = join(OUT_DIR, sanitize(ep.show_name ?? ep.show_key ?? 'unknown'))
    mkdirSync(showDir, { recursive: true })
    const fname = `${ep.air_date ?? 'nodate'}_${ep.id}.txt`
    writeFileSync(join(showDir, fname), text)
    written++
    const rel = join(sanitize(ep.show_name ?? ep.show_key ?? 'unknown'), fname)
    const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    manifest.push([
      q(ep.show_name ?? ''), ep.air_date ?? '', ep.air_start ?? '',
      String(ep.id), q(rel), String(text.length),
    ].join(','))
  }
  writeFileSync(join(OUT_DIR, 'manifest.csv'), manifest.join('\n'))
  console.log(`Wrote ${written} transcript files to ${OUT_DIR} (${empty} matched episodes had no ${field}).`)
  console.log(`Manifest: ${join(OUT_DIR, 'manifest.csv')}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
