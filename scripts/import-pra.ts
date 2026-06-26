/**
 * Import the Pacifica Radio Archives (PRA) catalog into episode_log as a one-off.
 *
 * The PRA audio lives in the operator's Cloudflare R2 `pra` bucket (digitized
 * "Flash Drive (64gb)/<collection>/…/<leaf>.mp3"). Unlike RSS/Confessor episodes
 * these are archival segments, not broadcasts — no air date/time, no broadcast
 * show. episode_log is the shared source of truth that kpfk-web reads, so the rows
 * live here, marked distinctly and carrying just enough provenance (folder, title,
 * PRA catalog code) to reconcile against the bucket. Everything downstream
 * (summaries, tagging, streaming, access restrictions) is done in kpfk-web.
 *
 * Source data: scripts/data/pra_manifest.csv — every .mp3 object in the bucket,
 * already parsed to (source, reference, title, source_folder, object_key, mp3_url,
 * transcript_url, bytes). See migration 038 + PRA_BUCKET_SCHEMA.md.
 *
 * PREREQUISITE: migration 038_pra_source.sql must be applied first (it adds the
 * source_ref / source_folder columns). The rows are inserted with:
 *   - station_id    = KPFK
 *   - ingest_source = 'pra'      (the provenance marker)
 *   - status        = 'archived' (inert — no pipeline worker selects it; in
 *                                 particular NOT 'pending', which the transcribe
 *                                 worker would grab via the air_date-null /
 *                                 created_at-in-quarter branch and fail on, since
 *                                 R2 URLs aren't publicly fetchable)
 *   - show_key      = 'pra'      (required + no FK; these aren't broadcast shows.
 *                                 The collection hierarchy lives in source_folder.)
 *
 * Idempotent: upserts on mp3_url (UNIQUE), so re-running is safe and re-applies
 * any parser fixes to the PRA columns without disturbing existing rows.
 *
 *   npx tsx scripts/import-pra.ts --dry-run     # parse + report, no DB writes
 *   npx tsx scripts/import-pra.ts               # upsert into episode_log
 *   npx tsx scripts/import-pra.ts --file <path> # use a different manifest CSV
 *
 * Requires the same env as the workers (SUPABASE service-role).
 */
import { supabaseAdmin } from '../lib/supabase'
import * as fs from 'fs/promises'
import * as path from 'path'

const KPFK_STATION_ID = '00000000-0000-4000-8000-000000000001'
const SHOW_KEY = 'pra'
const STATUS = 'archived'
const INGEST_SOURCE = 'pra'
const DEFAULT_MANIFEST = path.join(__dirname, 'data', 'pra_manifest.csv')
const BATCH_SIZE = 500

interface ManifestRow {
  source: string
  reference: string
  title: string
  source_folder: string
  object_key: string
  mp3_url: string
  transcript_url: string
  bytes: string
}

/**
 * Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas, escaped
 * ("") quotes, and CRLF. The manifest has titles like
 * `"Revolution Rewind- 1968 Year in Review, Part 1"` so naive split(',') is wrong.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let field = ''
  let record: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      record.push(field); field = ''
    } else if (c === '\n') {
      record.push(field); field = ''
      rows.push(record); record = []
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else {
      field += c
    }
  }
  // trailing field / record (file may not end in newline)
  if (field.length || record.length) { record.push(field); rows.push(record) }

  const header = rows.shift()
  if (!header) return []
  return rows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])))
}

function toEpisode(row: ManifestRow) {
  const ref = row.reference.trim()
  const transcript = row.transcript_url.trim()
  return {
    station_id: KPFK_STATION_ID,
    show_key: SHOW_KEY,
    ingest_source: INGEST_SOURCE,
    status: STATUS,
    title: row.title.trim(),
    source_ref: ref || null,
    source_folder: row.source_folder.trim() || null,
    mp3_url: row.mp3_url.trim(),
    transcript_url: transcript || null,
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const dryRun = argv.includes('--dry-run')
  const fileIdx = argv.indexOf('--file')
  const manifestPath = fileIdx >= 0 ? argv[fileIdx + 1] : DEFAULT_MANIFEST

  const text = await fs.readFile(manifestPath, 'utf8')
  const rows = parseCsv(text) as unknown as ManifestRow[]

  // Guard: only .mp3 objects are episodes. The manifest already excludes
  // .txt/.xlsx/etc, but assert the contract and drop anything malformed.
  const mp3s = rows.filter((r) => r.mp3_url && r.mp3_url.toLowerCase().endsWith('.mp3'))
  const episodes = mp3s.map(toEpisode)

  const withRef = episodes.filter((e) => e.source_ref).length
  const withTranscript = episodes.filter((e) => e.transcript_url).length
  const distinctUrls = new Set(episodes.map((e) => e.mp3_url)).size

  console.log(`[pra] manifest: ${manifestPath}`)
  console.log(`[pra] ${rows.length} rows → ${episodes.length} mp3 episodes`)
  console.log(`[pra]   with source_ref: ${withRef}   null ref: ${episodes.length - withRef}`)
  console.log(`[pra]   with transcript_url: ${withTranscript}`)
  console.log(`[pra]   distinct mp3_url: ${distinctUrls} (must equal episode count)`)
  if (distinctUrls !== episodes.length) {
    throw new Error('[pra] duplicate mp3_url in manifest — aborting (would collide on the UNIQUE key)')
  }
  console.log('[pra] sample:', JSON.stringify(episodes[0], null, 2))

  if (dryRun) {
    console.log('[pra] --dry-run: no DB writes.')
    return
  }

  let upserted = 0
  for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
    const batch = episodes.slice(i, i + BATCH_SIZE)
    const { error, count } = await supabaseAdmin
      .from('episode_log')
      .upsert(batch, { onConflict: 'mp3_url', count: 'exact' })
    if (error) {
      throw new Error(`[pra] upsert failed at batch ${i / BATCH_SIZE}: ${error.message}`)
    }
    upserted += count ?? batch.length
    console.log(`[pra] upserted ${Math.min(i + BATCH_SIZE, episodes.length)}/${episodes.length}`)
  }

  console.log(`[pra] done — ${upserted} rows upserted (station=KPFK, show_key='${SHOW_KEY}', status='${STATUS}').`)
}

main().catch((err) => {
  console.error('[pra] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
