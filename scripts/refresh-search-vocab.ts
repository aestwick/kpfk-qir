// Fold transcripts into the per-station search vocabulary (migration 046,
// public.search_vocab) that powers forgiving search: accent variants, plurals
// and misspellings ("Hartmann" also finds Whisper's "Hartman").
//
// Usage:
//   tsx scripts/refresh-search-vocab.ts            # every station, until caught up
//   tsx scripts/refresh-search-vocab.ts --batch 80 # transcripts per RPC call
//
// Incremental and re-runnable: refresh_search_vocab() keeps a per-station
// watermark (last episode id folded in), so a run only processes transcripts
// added since the previous one. The summarize worker calls the same helper
// after each batch, so this script is for the first fill and for catching up.

import { supabaseAdmin } from '../lib/supabase'
import { refreshSearchVocab } from '../lib/transcript-search'

const i = process.argv.indexOf('--batch')
const BATCH = i >= 0 ? Math.max(10, Number(process.argv[i + 1]) || 100) : 100

async function main() {
  const { data: stations, error } = await supabaseAdmin.from('stations').select('id, slug')
  if (error) throw new Error(error.message)
  for (const s of stations ?? []) {
    const t = Date.now()
    const n = await refreshSearchVocab(supabaseAdmin, s.id, { batch: BATCH, onBatch: (done) => {
      if (done % 1000 < BATCH) console.log(`[search-vocab] ${s.slug}: ${done} transcripts folded…`)
    } })
    console.log(`[search-vocab] ${s.slug}: ${n} transcripts folded in ${((Date.now() - t) / 1000).toFixed(0)}s`)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('[search-vocab] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
