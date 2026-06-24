/**
 * Standalone R2 → diarized transcript job.
 *
 * Transcribes a bunch of audio that lives in a Cloudflare R2 bucket and writes
 * one set of transcript files PER audio object to a local directory. This is a
 * one-off utility — it does NOT touch episode_log, stations, quarters, or the
 * QIR pipeline. It just reuses the pipeline's existing speech-to-text providers
 * (lib/transcription/{assemblyai,deepgram}) and VTT builder (lib/transcription/vtt).
 *
 * Why presigned URLs: AssemblyAI and Deepgram fetch the audio THEMSELVES over
 * HTTPS (no upload from us). R2 is S3-compatible, so for a private bucket we mint
 * a short-lived presigned GET URL per object via the S3 API and hand that to the
 * provider. Public-bucket users can skip the S3 creds and pass a base URL instead
 * (--public-base-url).
 *
 * Each provider diarizes (speaker labels) and timestamps; for every audio file we
 * write three artifacts to --out:
 *   <name>.vtt   — WebVTT with <v Speaker N> voice spans + cue timestamps (players)
 *   <name>.txt   — readable, speaker-separated, timestamped transcript (humans)
 *   <name>.json  — { source, provider, model, language, durationSec, segments[] }
 *
 * Usage (run on a host that has the R2 + provider keys in its env — e.g. the VPS):
 *
 *   # List + transcribe every audio object under a prefix, private bucket:
 *   npm run transcribe-r2 -- --bucket my-audio --prefix shows/2026-q2/ --provider assemblyai
 *
 *   # Specific keys only:
 *   npm run transcribe-r2 -- --bucket my-audio --keys a.mp3,b.m4a --provider deepgram
 *
 *   # Public bucket (no S3 creds needed): build URLs from a base + keys/prefix list:
 *   npm run transcribe-r2 -- --public-base-url https://pub-xxx.r2.dev --keys a.mp3,b.mp3
 *
 * Env (S3 path — put these in .env alongside DEEPGRAM_API_KEY / ASSEMBLYAI_API_KEY):
 *   R2_ACCOUNT_ID          Cloudflare account id (used to build the S3 endpoint)
 *   R2_ACCESS_KEY_ID       R2 S3 API token access key id
 *   R2_SECRET_ACCESS_KEY   R2 S3 API token secret
 *   R2_BUCKET              default bucket (overridable with --bucket)
 *   R2_ENDPOINT            optional explicit S3 endpoint (else https://<acct>.r2.cloudflarestorage.com)
 *
 * Flags:
 *   --bucket <name>          R2 bucket (default: $R2_BUCKET)
 *   --prefix <p>             only objects whose key starts with <p> (S3 listing)
 *   --keys <a,b,c>           explicit object keys (skips listing)
 *   --keys-file <path>       newline-delimited object keys (# comments + blanks ignored)
 *   --public-base-url <url>  build audio URLs as <base>/<key> instead of presigning (public bucket)
 *   --provider <id>          assemblyai | deepgram   (default: assemblyai)
 *   --out <dir>              output directory (default: ./transcripts)
 *   --no-diarize             disable speaker labels (diarization is ON by default)
 *   --concurrency <n>        parallel transcriptions (default: 2)
 *   --expires <sec>          presigned URL lifetime (default: 7200)
 *   --overwrite              re-transcribe even if <name>.json already exists
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import * as fs from 'fs/promises'
import * as path from 'path'
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
  out: string
  diarize: boolean
  concurrency: number
  expires: number
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
    out: get('--out') ?? './transcripts',
    diarize: !argv.includes('--no-diarize'),
    concurrency: Math.max(1, parseInt(get('--concurrency') ?? '2', 10) || 2),
    expires: Math.max(60, parseInt(get('--expires') ?? '7200', 10) || 7200),
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
      if (obj.Key && AUDIO_EXT.test(obj.Key) && !(obj.Key.endsWith('/'))) keys.push(obj.Key)
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

/** Resolve the HTTPS URL a provider will fetch for an object key. */
async function resolveAudioUrl(
  key: string,
  args: Args,
  s3: S3Client | null,
): Promise<string> {
  if (args.publicBaseUrl) {
    // Encode each path segment but keep the slashes.
    const encoded = key.split('/').map(encodeURIComponent).join('/')
    return `${args.publicBaseUrl}/${encoded}`
  }
  if (!s3 || !args.bucket) throw new Error('cannot presign without S3 client + bucket')
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: args.bucket, Key: key }), {
    expiresIn: args.expires,
  })
}

/** A safe, flat output basename for an object key (drops the extension). */
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

async function transcribeOne(
  key: string,
  args: Args,
  s3: S3Client | null,
): Promise<{ key: string; provider: string; durationSec: number; cost: number; diarized: boolean }> {
  const provider = PROVIDERS[args.provider]
  const base = outBaseName(key)
  const jsonPath = path.join(args.out, `${base}.json`)

  if (!args.overwrite) {
    try {
      await fs.access(jsonPath)
      console.log(`[transcribe-r2] skip (exists): ${key}`)
      const prior = JSON.parse(await fs.readFile(jsonPath, 'utf8'))
      return {
        key,
        provider: prior.provider ?? args.provider,
        durationSec: prior.durationSec ?? 0,
        cost: 0,
        diarized: !!prior.diarized,
      }
    } catch {
      /* not present — transcribe */
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
  const speakerText = buildSpeakerText(result.segments)
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

  await Promise.all([
    fs.writeFile(path.join(args.out, `${base}.vtt`), vtt),
    fs.writeFile(path.join(args.out, `${base}.txt`), speakerText + '\n'),
    fs.writeFile(jsonPath, json),
  ])

  const cost = estimateTranscriptionCost(result.providerId, result.durationSec)
  const mins = (result.durationSec / 60).toFixed(1)
  console.log(
    `[transcribe-r2] ✓ ${key} — ${mins} min, ${result.segments.length} segs, ` +
      `${result.diarized ? 'diarized' : 'NOT diarized'}, ~$${cost.toFixed(4)} → ${base}.{vtt,txt,json}`,
  )
  return { key, provider: result.providerId, durationSec: result.durationSec, cost, diarized: result.diarized }
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

  // Decide where keys come from: explicit list, or S3 listing under a prefix.
  let explicitKeys = await loadKeyList(args)
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

  if (!keys.length) {
    console.log('[transcribe-r2] no audio objects matched — nothing to do.')
    return
  }

  await fs.mkdir(args.out, { recursive: true })
  console.log(
    `[transcribe-r2] ${keys.length} file(s) · provider=${args.provider} · ` +
      `diarize=${args.diarize} · concurrency=${args.concurrency} · out=${path.resolve(args.out)}\n`,
  )

  const results = await mapPool(keys, args.concurrency, (key) => transcribeOne(key, args, s3))

  const ok = results.filter((r) => r.value)
  const failed = results.filter((r) => r.error)
  const totalCost = ok.reduce((s, r) => s + (r.value!.cost ?? 0), 0)
  const totalMin = ok.reduce((s, r) => s + (r.value!.durationSec ?? 0), 0) / 60
  const notDiarized = ok.filter((r) => args.diarize && !r.value!.diarized)

  console.log(`\n[transcribe-r2] done: ${ok.length} ok, ${failed.length} failed.`)
  if (ok.length) console.log(`[transcribe-r2] ~${totalMin.toFixed(0)} min audio, est. ~$${totalCost.toFixed(2)}.`)
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
