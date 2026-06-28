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
 * download the .txt/.vtt/.json from Storage (the three concurrently), and upsert
 * one row into transcripts (transcript=txt, vtt=vtt, provider/model/language from
 * the json) keyed by the 1:1 episode_id. A worker pool runs many episodes at once.
 *
 * Idempotent + resumable: skips episodes that already have a transcript row, so
 * re-running continues where a prior run left off.
 *
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx tsx scripts/import-pra-transcripts.ts --dry-run        # match + sample, no writes
 *     npx tsx scripts/import-pra-transcripts.ts                  # load all (12-wide)
 *     npx tsx scripts/import-pra-transcripts.ts --concurrency 20 # tune parallelism
 *     npx tsx scripts/import-pra-transcripts.ts --overwrite      # re-load even if present
 *
 * Only the Supabase service-role env is needed (the transcripts live in Storage
 * now, not R2 — no R2 creds required).
 */
import { supabaseAdmin } from '../lib/supabase'

const STORAGE_BUCKET = 'Transcripts'
const R2_PREFIX = /^\/pra\//
const PAGE = 1000
const DEFAULT_CONCURRENCY = 12

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

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function runner() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      await worker(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner))
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const overwrite = argv.includes('--overwrite')
  const cIdx = argv.indexOf('--concurrency')
  const concurrency = cIdx >= 0 ? Math.max(1, parseInt(argv[cIdx + 1], 10) || DEFAULT_CONCURRENCY) : DEFAULT_CONCURRENCY

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
    for (let from = 0; from < episodes.length; from += PAGE) {
      const ids = episodes.slice(from, from + PAGE).map((e) => e.id)
      const { data, error } = await supabaseAdmin.from('transcripts').select('episode_id').in('episode_id', ids)
      if (error) throw new Error(`load existing transcripts: ${error.message}`)
      for (const r of data ?? []) have.add((r as { episode_id: number }).episode_id)
    }
  }
  const todo = episodes.filter((e) => overwrite || !have.has(e.id))
  console.log(`[pra-tx] ${have.size} already have a transcript; ${todo.length} to load (concurrency ${concurrency})`)

  if (dryRun) {
    const sample = todo[0] ?? episodes[0]
    const base = storageBase(sample.mp3_url)
    console.log(`[pra-tx] sample episode ${sample.id} → storage base: ${base}`)
    const [txt, vtt, json] = await Promise.all([
      downloadText(`${base}.txt`), downloadText(`${base}.vtt`), downloadText(`${base}.json`),
    ])
    console.log(`[pra-tx]   .txt: ${txt ? txt.length + ' bytes' : 'MISSING'}`)
    console.log(`[pra-tx]   .vtt: ${vtt ? vtt.length + ' bytes' : 'MISSING'}`)
    console.log(`[pra-tx]   .json: ${json ? json.length + ' bytes' : 'MISSING'}`)
    if (json) { try { const m = JSON.parse(json); console.log(`[pra-tx]   provider=${m.provider} model=${m.model} language=${m.language}`) } catch { /* ignore */ } }
    console.log('[pra-tx] --dry-run: no DB writes.')
    return
  }

  let loaded = 0, missing = 0, failed = 0, done = 0
  await runPool(todo, concurrency, async (ep) => {
    const base = storageBase(ep.mp3_url)
    try {
      const [txt, vtt, jsonRaw] = await Promise.all([
        downloadText(`${base}.txt`), downloadText(`${base}.vtt`), downloadText(`${base}.json`),
      ])
      if (txt == null) { missing++; return } // no transcript artifact for this one
      let provider: string | null = null, model: string | null = null, language: string | null = null
      if (jsonRaw) {
        try { const m = JSON.parse(jsonRaw); provider = m.provider ?? null; model = m.model ?? null; language = m.language ?? null } catch { /* keep nulls */ }
      }
      const { error } = await supabaseAdmin
        .from('transcripts')
        .upsert({ episode_id: ep.id, transcript: txt, vtt, provider, model, language }, { onConflict: 'episode_id' })
      if (error) { failed++; console.warn(`[pra-tx] ep ${ep.id} upsert failed: ${error.message}`); return }
      loaded++
    } catch (err) {
      failed++; console.warn(`[pra-tx] ep ${ep.id} error: ${err instanceof Error ? err.message : err}`)
    } finally {
      if (++done % 100 === 0) console.log(`[pra-tx] ${done}/${todo.length} processed (loaded ${loaded}, missing ${missing}, failed ${failed})`)
    }
  })

  console.log(`[pra-tx] done — loaded ${loaded}, no-artifact ${missing}, failed ${failed} (of ${todo.length}).`)
}

main().catch((err) => {
  console.error('[pra-tx] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
