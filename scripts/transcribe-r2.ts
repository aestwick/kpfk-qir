/**
 * Standalone R2 → diarized transcript job.
 *
 * Transcribes a bunch of audio that lives in a Cloudflare R2 bucket and writes
 * one set of transcript artifacts PER audio object — to a Supabase Storage bucket
 * and/or a local directory. This is a one-off utility — it does NOT touch
 * episode_log, stations, quarters, or the QIR pipeline. It just reuses the
 * pipeline's existing speech-to-text providers (lib/transcription/{assemblyai,
 * deepgram}) and VTT builder (lib/transcription/vtt).
 *
 * Why presigned URLs: AssemblyAI and Deepgram fetch the audio THEMSELVES over
 * HTTPS (no upload from us). R2 is S3-compatible, so for a private bucket we mint
 * a short-lived presigned GET URL per object via the S3 API and hand that to the
 * provider. Public-bucket users can skip the S3 creds and pass a base URL instead
 * (--public-base-url).
 *
 * Each provider diarizes (speaker labels) and timestamps; for every audio file we
 * produce three artifacts:
 *   <key>.vtt   — WebVTT with <v Speaker N> voice spans + cue timestamps (players)
 *   <key>.txt   — readable, speaker-separated, timestamped transcript (humans)
 *   <key>.json  — { source, provider, model, language, durationSec, segments[] }
 *
 * Destinations:
 *   --supabase / --supabase-bucket <name>   upload artifacts to a Supabase Storage
 *                                           bucket (default bucket name: transcripts).
 *                                           Object paths mirror the R2 key (folders
 *                                           preserved, audio extension swapped).
 *   --out <dir>                             also/instead write flat files locally.
 *   If a Supabase bucket is given, upload is the default and local writing is OFF
 *   unless you also pass --out. With no Supabase bucket, it writes locally only.
 *
 * Usage (run INSIDE the worker container, which has the env + tsx):
 *
 *   docker exec qir-worker npm run transcribe-r2 -- \
 *     --bucket pra --provider assemblyai --supabase
 *
 * Env (S3 path — in .env alongside DEEPGRAM_API_KEY / ASSEMBLYAI_API_KEY):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_ENDPOINT (optional; else https://<acct>.r2.cloudflarestorage.com)
 * Supabase upload reuses NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Flags:
 *   --bucket <name>          R2 bucket (default: $R2_BUCKET)
 *   --prefix <p>             only objects whose key starts with <p> (S3 listing)
 *   --keys <a,b,c>           explicit object keys (skips listing)
 *   --keys-file <path>       newline-delimited object keys (# comments + blanks ignored)
 *   --public-base-url <url>  build audio URLs as <base>/<key> instead of presigning (public bucket)
 *   --provider <id>          assemblyai | deepgram   (default: assemblyai)
 *   --supabase               upload artifacts to Supabase Storage bucket "transcripts"
 *   --supabase-bucket <name> upload to a named Supabase Storage bucket
 *   --out <dir>              also write flat files to a local directory
 *   --no-diarize             disable speaker labels (diarization is ON by default)
 *   --concurrency <n>        parallel transcriptions (default: 2)
 *   --expires <sec>          presigned URL lifetime (default: 7200)
 *   --limit <n>              transcribe at most the first <n> objects (sampling/A-B)
 *   --overwrite              re-transcribe even if the .json artifact already exists
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as fs from 'fs/promises'
import * as path from 'path'
import { supabaseAdmin } from '../lib/supabase'
import { assemblyaiProvider } from '../lib/transcription/assemblyai'
import { deepgramProvider } from '../lib/transcription/deepgram'
import { buildVtt, formatVttTime } from '../lib/transcription/vtt'
import { estimateTranscriptionCost } from '../lib/transcription'
import type {
  NormalizedSegment,
  TranscribeContext,
  TranscriptionProvider,
  TranscriptionResult,
} from '../lib/transcription/types'

const AUDIO_EXT = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|webm|mov)$/i
const DEFAULT_SUPABASE_BUCKET = 'transcripts'

const PROVIDERS: Record<string, TranscriptionProvider> = {
  assemblyai: assemblyaiProvider,
  deepgram: deepgramProvider,
}

interface Args {
  bucket: string | undefined
  prefix: string | undefined
  keys: string[]
  keysFile: string | undefined
  publicBaseUrl: string | undefined
  provider: string
  supabaseBucket: string | undefined
  out: string | undefined
  diarize: boolean
  concurrency: number
  expires: number
  limit: number | undefined
  overwrite: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const provider = (get('--provider') ?? 'assemblyai').toLowerCase()
  if (!PROVIDERS[provider]) {
    throw new Error(`--provider must be one of: ${Object.keys(PROVIDERS).join(', ')} (got "${provider}")`)
  }
  const supabaseBucket = argv.includes('--supabase')
    ? get('--supabase-bucket') ?? DEFAULT_SUPABASE_BUCKET
    : get('--supabase-bucket')
  // Local output: explicit --out, or (when no Supabase target) a sensible default.
  const outFlag = get('--out')
  const out = outFlag ?? (supabaseBucket ? undefined : './transcripts')
  const limitRaw = get('--limit')
  return {
    bucket: get('--bucket') ?? process.env.R2_BUCKET,
    prefix: get('--prefix'),
    keys: (get('--keys') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    keysFile: get('--keys-file'),
    publicBaseUrl: get('--public-base-url')?.replace(/\/+$/, ''),
    provider,
    supabaseBucket,
    out,
    diarize: !argv.includes('--no-diarize'),
    concurrency: Math.max(1, parseInt(get('--concurrency') ?? '2', 10) || 2),
    expires: Math.max(60, parseInt(get('--expires') ?? '7200', 10) || 7200),
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 1) : undefined,
    overwrite: argv.includes('--overwrite'),
  }
}

function makeS3(): S3Client {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined)
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 S3 credentials missing. Set R2_ACCOUNT_ID (or R2_ENDPOINT), R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY — or use --public-base-url for a public bucket.',
    )
  }
  // R2 ignores region but the SDK requires one; "auto" is the documented value.
  return new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } })
}

/** Enumerate audio object keys under a prefix (paginated). */
async function listAudioKeys(s3: S3Client, bucket: string, prefix: string | undefined): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    )
    for (const obj of res.Contents ?? []) {
      if (obj.Key && AUDIO_EXT.test(obj.Key) && !obj.Key.endsWith('/')) keys.push(obj.Key)
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

/** Resolve the HTTPS URL a provider will fetch for an object key. */
async function resolveAudioUrl(key: string, args: Args, s3: S3Client | null): Promise<string> {
  if (args.publicBaseUrl) {
    const encoded = key.split('/').map(encodeURIComponent).join('/')
    return `${args.publicBaseUrl}/${encoded}`
  }
  if (!s3 || !args.bucket) throw new Error('cannot presign without S3 client + bucket')
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: args.bucket, Key: key }), {
    expiresIn: args.expires,
  })
}

/** Storage object path mirroring the R2 key with the audio extension swapped. */
function storageKey(key: string, ext: string): string {
  return `${key.replace(/\.[^.]+$/, '')}.${ext}`
}

/** Flat local basename for an object key (drops the extension). */
function outBaseName(key: string): string {
  const stripped = key.replace(/\.[^.]+$/, '')
  return stripped.replace(/[\/\\]+/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Readable speaker-separated transcript: consecutive same-speaker segments merged. */
function buildSpeakerText(segments: NormalizedSegment[]): string {
  const blocks: Array<{ speaker: string; start: number; text: string }> = []
  for (const seg of segments) {
    const text = seg.text.trim()
    if (!text) continue
    const speaker = seg.speaker ?? 'Speaker ?'
    const last = blocks[blocks.length - 1]
    if (last && last.speaker === speaker) {
      last.text += ' ' + text
    } else {
      blocks.push({ speaker, start: seg.startSec, text })
    }
  }
  return blocks.map((b) => `[${formatVttTime(b.start)}] ${b.speaker}:\n${b.text}`).join('\n\n')
}

/** Ensure a (private) Supabase Storage bucket exists. */
async function ensureBucket(bucket: string): Promise<void> {
  const { data: buckets, error } = await supabaseAdmin.storage.listBuckets()
  if (error) throw new Error(`Supabase listBuckets failed: ${error.message}`)
  if (buckets?.some((b) => b.name === bucket)) return
  const { error: createErr } = await supabaseAdmin.storage.createBucket(bucket, { public: false })
  if (createErr && !/already exists|duplicate/i.test(createErr.message)) {
    throw new Error(`Supabase createBucket(${bucket}) failed: ${createErr.message}`)
  }
  console.log(`[transcribe-r2] created private Supabase Storage bucket "${bucket}"`)
}

/** Does an object already exist in the Supabase bucket? */
async function storageExists(bucket: string, objectPath: string): Promise<boolean> {
  const slash = objectPath.lastIndexOf('/')
  const dir = slash >= 0 ? objectPath.slice(0, slash) : ''
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath
  const { data } = await supabaseAdmin.storage.from(bucket).list(dir, { search: name, limit: 100 })
  return !!data?.some((o) => o.name === name)
}

async function uploadArtifact(
  bucket: string,
  objectPath: string,
  body: string,
  contentType: string,
): Promise<void> {
  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(objectPath, Buffer.from(body, 'utf8'), { contentType, upsert: true })
  if (error) throw new Error(`Supabase upload ${objectPath}: ${error.message}`)
}

interface OneResult {
  key: string
  provider: string
  durationSec: number
  cost: number
  diarized: boolean
  skipped: boolean
}

async function transcribeOne(key: string, args: Args, s3: S3Client | null): Promise<OneResult> {
  const provider = PROVIDERS[args.provider]
  const jsonStorageKey = storageKey(key, 'json')
  const localBase = args.out ? outBaseName(key) : null
  const localJsonPath = args.out && localBase ? path.join(args.out, `${localBase}.json`) : null

  // Skip-if-exists keyed on the .json artifact at the configured destination(s).
  if (!args.overwrite) {
    const present = args.supabaseBucket
      ? await storageExists(args.supabaseBucket, jsonStorageKey)
      : localJsonPath
        ? await fs
            .access(localJsonPath)
            .then(() => true)
            .catch(() => false)
        : false
    if (present) {
      console.log(`[transcribe-r2] skip (exists): ${key}`)
      return { key, provider: args.provider, durationSec: 0, cost: 0, diarized: false, skipped: true }
    }
  }

  const url = await resolveAudioUrl(key, args, s3)
  const ctx: TranscribeContext = {
    episodeId: 0, // not an episode — URL providers never use this
    mp3Url: url,
    diarize: args.diarize,
    chunkDurationSec: 0,
    getLocalChunks: async () => {
      throw new Error('local chunking is not used for URL-based providers')
    },
  }

  console.log(`[transcribe-r2] → ${args.provider}: ${key}`)
  const result: TranscriptionResult = await provider.transcribe(ctx)

  const vtt = buildVtt(result.segments, [], args.diarize)
  const txt = buildSpeakerText(result.segments) + '\n'
  const json = JSON.stringify(
    {
      source: { bucket: args.bucket ?? null, key, url: args.publicBaseUrl ? url : '<presigned>' },
      provider: result.providerId,
      model: result.model,
      language: result.language,
      durationSec: result.durationSec,
      diarized: result.diarized,
      segments: result.segments,
    },
    null,
    2,
  )

  const dests: string[] = []
  if (args.supabaseBucket) {
    await Promise.all([
      uploadArtifact(args.supabaseBucket, storageKey(key, 'vtt'), vtt, 'text/vtt'),
      uploadArtifact(args.supabaseBucket, storageKey(key, 'txt'), txt, 'text/plain; charset=utf-8'),
      uploadArtifact(args.supabaseBucket, jsonStorageKey, json, 'application/json'),
    ])
    dests.push(`supabase:${args.supabaseBucket}/${storageKey(key, '{vtt,txt,json}')}`)
  }
  if (args.out && localBase) {
    await Promise.all([
      fs.writeFile(path.join(args.out, `${localBase}.vtt`), vtt),
      fs.writeFile(path.join(args.out, `${localBase}.txt`), txt),
      fs.writeFile(path.join(args.out, `${localBase}.json`), json),
    ])
    dests.push(`local:${localBase}.{vtt,txt,json}`)
  }

  const cost = estimateTranscriptionCost(result.providerId, result.durationSec)
  const mins = (result.durationSec / 60).toFixed(1)
  console.log(
    `[transcribe-r2] ✓ ${key} — ${mins} min, ${result.segments.length} segs, ` +
      `${result.diarized ? 'diarized' : 'NOT diarized'}, ~$${cost.toFixed(4)} → ${dests.join(' + ')}`,
  )
  return { key, provider: result.providerId, durationSec: result.durationSec, cost, diarized: result.diarized, skipped: false }
}

/** Run `worker` over `items` with at most `limit` in flight; collect {ok|err}. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<Array<{ item: T; value?: R; error?: string }>> {
  const out: Array<{ item: T; value?: R; error?: string }> = new Array(items.length)
  let next = 0
  async function runner() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { item: items[i], value: await worker(items[i]) }
      } catch (err) {
        out[i] = { item: items[i], error: err instanceof Error ? err.message : String(err) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner))
  return out
}

async function loadKeyList(args: Args): Promise<string[]> {
  const keys = [...args.keys]
  if (args.keysFile) {
    const raw = await fs.readFile(args.keysFile, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const k = line.trim()
      if (k && !k.startsWith('#')) keys.push(k)
    }
  }
  return Array.from(new Set(keys))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const provider = PROVIDERS[args.provider]
  if (!provider.isConfigured()) {
    throw new Error(
      `${args.provider} is selected but its API key is not set in the environment ` +
        `(${args.provider === 'assemblyai' ? 'ASSEMBLYAI_API_KEY' : 'DEEPGRAM_API_KEY'}).`,
    )
  }
  if (!args.supabaseBucket && !args.out) {
    throw new Error('no destination — pass --supabase / --supabase-bucket <name> and/or --out <dir>')
  }

  // Decide where keys come from: explicit list, or S3 listing under a prefix.
  const explicitKeys = await loadKeyList(args)
  const usingS3 = !args.publicBaseUrl
  const s3 = usingS3 ? makeS3() : null

  let keys: string[]
  if (explicitKeys.length) {
    keys = explicitKeys
  } else if (usingS3) {
    if (!args.bucket) throw new Error('--bucket (or $R2_BUCKET) is required when listing objects')
    console.log(`[transcribe-r2] listing audio in r2://${args.bucket}/${args.prefix ?? ''} …`)
    keys = await listAudioKeys(s3!, args.bucket, args.prefix)
  } else {
    throw new Error('--public-base-url needs --keys/--keys-file (cannot list a public bucket without S3 creds)')
  }

  if (args.limit && keys.length > args.limit) {
    console.log(`[transcribe-r2] limiting to first ${args.limit} of ${keys.length} objects`)
    keys = keys.slice(0, args.limit)
  }

  if (!keys.length) {
    console.log('[transcribe-r2] no audio objects matched — nothing to do.')
    return
  }

  if (args.supabaseBucket) await ensureBucket(args.supabaseBucket)
  if (args.out) await fs.mkdir(args.out, { recursive: true })

  const destLabel = [
    args.supabaseBucket ? `supabase://${args.supabaseBucket}` : null,
    args.out ? `local://${path.resolve(args.out)}` : null,
  ]
    .filter(Boolean)
    .join(' + ')
  console.log(
    `[transcribe-r2] ${keys.length} file(s) · provider=${args.provider} · diarize=${args.diarize} · ` +
      `concurrency=${args.concurrency} · → ${destLabel}\n`,
  )

  const results = await mapPool(keys, args.concurrency, (key) => transcribeOne(key, args, s3))

  const ok = results.filter((r) => r.value)
  const failed = results.filter((r) => r.error)
  const done = ok.filter((r) => !r.value!.skipped)
  const skipped = ok.filter((r) => r.value!.skipped)
  const totalCost = done.reduce((s, r) => s + (r.value!.cost ?? 0), 0)
  const totalMin = done.reduce((s, r) => s + (r.value!.durationSec ?? 0), 0) / 60
  const notDiarized = done.filter((r) => args.diarize && !r.value!.diarized)

  console.log(
    `\n[transcribe-r2] done: ${done.length} transcribed, ${skipped.length} skipped, ${failed.length} failed.`,
  )
  if (done.length) console.log(`[transcribe-r2] ~${totalMin.toFixed(0)} min audio, est. ~$${totalCost.toFixed(2)}.`)
  if (notDiarized.length) {
    console.warn(
      `[transcribe-r2] note: ${notDiarized.length} file(s) returned no speaker labels ` +
        `(single speaker, or provider couldn't separate): ${notDiarized.map((r) => r.item).join(', ')}`,
    )
  }
  if (failed.length) {
    console.error('[transcribe-r2] failures:')
    for (const f of failed) console.error(`  ✗ ${f.item}: ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[transcribe-r2] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
