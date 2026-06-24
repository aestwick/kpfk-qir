/**
 * One-off: push already-produced transcribe-r2 output (the flat-named
 * .vtt/.txt/.json saved from /app/transcripts) into a Supabase Storage bucket
 * under the SAME object paths the current transcribe-r2 would use — so a later
 * transcribe-r2 run's skip-if-exists treats them as already done and never
 * re-transcribes them (no double charge).
 *
 * Each saved .json records the original R2 object key in `source.key`; we mirror
 * that as `<key without ext>.{vtt,txt,json}` in the bucket — identical to
 * scripts/transcribe-r2.ts#storageKey, so the keys line up exactly.
 *
 * Self-contained: only needs @supabase/supabase-js + env
 * (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). Both are present in the
 * qir-worker container, so it runs there with no rebuild:
 *
 *   cd /root/qir
 *   git fetch origin claude/gallant-pascal-ronwwq
 *   git show origin/claude/gallant-pascal-ronwwq:scripts/upload-saved-transcripts.ts > /tmp/upload-saved.ts
 *   docker cp /tmp/upload-saved.ts qir-worker:/app/upload-saved.ts
 *   docker exec qir-worker npx tsx upload-saved.ts --dir /app/transcripts --bucket Transcripts
 *
 * Flags:
 *   --dir <path>     directory of saved .json/.vtt/.txt (default ./transcripts)
 *   --bucket <name>  Supabase Storage bucket (default Transcripts)
 *   --overwrite      re-upload even if the .json object already exists
 */
import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs/promises'
import * as path from 'path'

function arg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : def
}

const DIR = arg('--dir', './transcripts')!
const BUCKET = arg('--bucket', 'Transcripts')!
const OVERWRITE = process.argv.includes('--overwrite')

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!URL || !KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}
const sb = createClient(URL, KEY)

// Must match scripts/transcribe-r2.ts#storageKey exactly.
function storageKey(k: string, ext: string): string {
  return `${k.replace(/\.[^.]+$/, '')}.${ext}`
}

const CT: Record<string, string> = {
  vtt: 'text/vtt',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
}

async function ensureBucket(bucket: string): Promise<void> {
  const { data, error } = await sb.storage.listBuckets()
  if (error) throw new Error(`listBuckets: ${error.message}`)
  if (data?.some((b) => b.name === bucket)) return
  const { error: ce } = await sb.storage.createBucket(bucket, { public: false })
  if (ce && !/already exists|duplicate/i.test(ce.message)) throw new Error(`createBucket: ${ce.message}`)
  console.log(`created private bucket "${bucket}"`)
}

async function objectExists(objectPath: string): Promise<boolean> {
  const slash = objectPath.lastIndexOf('/')
  const dir = slash >= 0 ? objectPath.slice(0, slash) : ''
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath
  const { data } = await sb.storage.from(BUCKET).list(dir, { search: name, limit: 100 })
  return !!data?.some((o) => o.name === name)
}

async function upload(objectPath: string, body: Buffer, ext: string): Promise<void> {
  const { error } = await sb.storage
    .from(BUCKET)
    .upload(objectPath, body, { contentType: CT[ext], upsert: true })
  if (error) throw new Error(`upload ${objectPath}: ${error.message}`)
}

async function main() {
  await ensureBucket(BUCKET)
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json'))
  console.log(`${files.length} transcript(s) in ${DIR} → supabase://${BUCKET}\n`)

  let ok = 0
  let skipped = 0
  let failed = 0
  for (const jsonFile of files) {
    const base = jsonFile.slice(0, -'.json'.length)
    try {
      const jsonRaw = await fs.readFile(path.join(DIR, jsonFile), 'utf8')
      const meta = JSON.parse(jsonRaw)
      const srcKey: string | undefined = meta?.source?.key
      if (!srcKey) {
        console.warn(`✗ ${jsonFile}: no source.key — cannot map to a bucket path`)
        failed++
        continue
      }
      const jsonPath = storageKey(srcKey, 'json')
      if (!OVERWRITE && (await objectExists(jsonPath))) {
        skipped++
        continue
      }
      const [vttR, txtR] = await Promise.allSettled([
        fs.readFile(path.join(DIR, `${base}.vtt`)),
        fs.readFile(path.join(DIR, `${base}.txt`)),
      ])
      await upload(jsonPath, Buffer.from(jsonRaw, 'utf8'), 'json')
      if (vttR.status === 'fulfilled') await upload(storageKey(srcKey, 'vtt'), vttR.value, 'vtt')
      if (txtR.status === 'fulfilled') await upload(storageKey(srcKey, 'txt'), txtR.value, 'txt')
      const partial = vttR.status !== 'fulfilled' || txtR.status !== 'fulfilled'
      console.log(`✓ ${srcKey}${partial ? '  (partial — missing vtt/txt)' : ''}`)
      ok++
    } catch (e) {
      console.error(`✗ ${jsonFile}: ${e instanceof Error ? e.message : e}`)
      failed++
    }
  }
  console.log(`\ndone: ${ok} uploaded, ${skipped} already present, ${failed} failed.`)
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('fatal:', e instanceof Error ? e.message : e)
  process.exit(1)
})
