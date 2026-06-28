/**
 * Load the PRA transcripts (already produced + paid for by transcribe-r2.ts and
 * uploaded to the Supabase Storage bucket "Transcripts") into the `transcripts`
 * DB table, linked to the PRA episodes.
 *
 * transcribe-r2 wrote three artifacts per audio object, at paths that mirror the
 * R2 key:
 *   <key>.txt   — readable, speaker-separated, timestamped transcript
 *   <key>.vtt   — WebVTT (<v Speaker N> spans + cue timestamps)
 *   <key>.json  — { source, provider, model, language, durationSec, segments[] }
 * where <key> is the audio object key WITHOUT the .mp3 extension.
 *
 * For each PRA episode (ingest_source='pra'), we derive that key from mp3_url,
 * download the .txt/.vtt/.json from Storage, and upsert one row into transcripts
 * (transcript=txt, vtt=vtt, provider/model/language from the json) keyed by the
 * 1:1 episode_id. Idempotent: skips episodes that already have a transcript row,
 * so it's safe to re-run / resume.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx tsx scripts/import-pra-transcripts.ts --dry-run   # match + sample, no writes
 *     npx tsx scripts/import-pra-transcripts.ts             # load all
 *     npx tsx scripts/import-pra-transcripts.ts --overwrite # re-load even if present
 *
 * Only the Supabase service-role env is needed (the transcripts live in Storage
 * now, not R2 — no R2 creds required).
 */
import { supabaseAdmin } from '../lib/supabase'

const STORAGE_BUCKET = 'Transcripts'
const R2_PREFIX = /^\/pra\//
const PAGE = 1000

interface Ep { id: number; mp3_url: string }

/** Storage path (no extension) for an episode's transcript artifacts. */
function storageBase(mp3Url: string): string {
  return decodeURIComponent(new URL(mp3Url).pathname).replace(R2_PREFIX, '').replace(/\.mp3$/i, '')
}

async function downloadText(path: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(path)
  if (error || !data) return null
  return await data.text()
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const overwrite = argv.includes('--overwrite')

  // All PRA episodes, paged.
  const episodes: Ep[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('episode_log')
      .select('id, mp3_url')
      .eq('ingest_source', 'pra')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load episodes: ${error.message}`)
    if (!data?.length) break
    episodes.push(...(data as Ep[]))
    if (data.length < PAGE) break
  }
  console.log(`[pra-tx] ${episodes.length} PRA episodes`)

  // Which already have a transcript row (skip unless --overwrite).
  const have = new Set<number>()
  if (!overwrite) {
    for (let from = 0; ; from += PAGE) {
      const ids = episodes.slice(from, from + PAGE).map((e) => e.id)
      if (!ids.length) break
      const { data, error } = await supabaseAdmin.from('transcripts').select('episode_id').in('episode_id', ids)
      if (error) throw new Error(`load existing transcripts: ${error.message}`)
      for (const r of data ?? []) have.add((r as { episode_id: number }).episode_id)
    }
  }
  const todo = episodes.filter((e) => overwrite || !have.has(e.id))
  console.log(`[pra-tx] ${have.size} already have a transcript; ${todo.length} to load`)

  if (dryRun) {
    const sample = todo[0] ?? episodes[0]
    const base = storageBase(sample.mp3_url)
    console.log(`[pra-tx] sample episode ${sample.id} → storage base: ${base}`)
    const txt = await downloadText(`${base}.txt`)
    const vtt = await downloadText(`${base}.vtt`)
    const json = await downloadText(`${base}.json`)
    console.log(`[pra-tx]   .txt: ${txt ? txt.length + ' bytes' : 'MISSING'}`)
    console.log(`[pra-tx]   .vtt: ${vtt ? vtt.length + ' bytes' : 'MISSING'}`)
    console.log(`[pra-tx]   .json: ${json ? json.length + ' bytes' : 'MISSING'}`)
    if (json) {
      try {
        const m = JSON.parse(json)
        console.log(`[pra-tx]   provider=${m.provider} model=${m.model} language=${m.language}`)
      } catch { /* ignore */ }
    }
    console.log('[pra-tx] --dry-run: no DB writes.')
    return
  }

  let loaded = 0, missing = 0, failed = 0
  for (const ep of todo) {
    const base = storageBase(ep.mp3_url)
    const txt = await downloadText(`${base}.txt`)
    if (txt == null) { missing++; continue } // no transcript artifact for this one
    const vtt = await downloadText(`${base}.vtt`)
    const jsonRaw = await downloadText(`${base}.json`)
    let provider: string | null = null, model: string | null = null, language: string | null = null
    if (jsonRaw) {
      try {
        const m = JSON.parse(jsonRaw)
        provider = m.provider ?? null; model = m.model ?? null; language = m.language ?? null
      } catch { /* keep nulls */ }
    }
    const { error } = await supabaseAdmin
      .from('transcripts')
      .upsert({ episode_id: ep.id, transcript: txt, vtt, provider, model, language }, { onConflict: 'episode_id' })
    if (error) { failed++; console.warn(`[pra-tx] ep ${ep.id} upsert failed: ${error.message}`); continue }
    loaded++
    if (loaded % 100 === 0) console.log(`[pra-tx] loaded ${loaded}/${todo.length} (missing ${missing}, failed ${failed})`)
  }

  console.log(`[pra-tx] done — loaded ${loaded}, no-artifact ${missing}, failed ${failed} (of ${todo.length}).`)
}

main().catch((err) => {
  console.error('[pra-tx] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
