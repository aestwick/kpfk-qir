/**
 * Standalone summarization pass over bucket transcripts.
 *
 * Reads the `.txt` transcripts that `transcribe-r2` wrote to a Supabase Storage
 * bucket, summarizes each with OpenAI, and writes a sibling `<key>.summary.json`
 * back to the same bucket. This is a one-off utility — it does NOT touch
 * episode_log, stations, or the QIR pipeline; the QIR summarizer
 * (workers/summarize.ts, FCC archival-log prompt) is unrelated to this.
 *
 * Work-list: the canonical object keys come from listing the R2 audio bucket
 * (same source as transcribe-r2). No audio is downloaded here — only the key
 * NAMES are used to locate each transcript at `<key>.txt` in the Supabase
 * bucket. Pass --keys/--keys-file/--prefix to scope it, exactly like
 * transcribe-r2.
 *
 * Per key:
 *   read   supabase://<bucket>/<key>.txt          (skip "missing" if not transcribed yet)
 *   skip   if <key>.summary.json already exists    (unless --overwrite)
 *   write  supabase://<bucket>/<key>.summary.json
 *            { source, model, headline, summary, usage, costUsd, generatedAt }
 *
 * Usage (run INSIDE the worker container, which has OPENAI_API_KEY + R2 + Supabase env):
 *
 *   docker exec qir-worker npm run summarize-r2 -- \
 *     --bucket pra --supabase-bucket Transcripts --concurrency 4
 *
 * Tip: do a small `--limit 5` pass first and eyeball the .summary.json output
 * before running the whole archive.
 *
 * Flags:
 *   --bucket <name>          R2 bucket to enumerate keys from (default: $R2_BUCKET)
 *   --prefix <p>             only keys starting with <p> (S3 listing)
 *   --keys <a,b,c>           explicit audio keys (skips R2 listing)
 *   --keys-file <path>       newline-delimited keys (# comments + blanks ignored)
 *   --supabase-bucket <name> Supabase Storage bucket holding the transcripts (default: transcripts)
 *   --model <id>             OpenAI model (default: gpt-4o)
 *   --prompt-file <path>     override the built-in summarization prompt
 *   --out <dir>              also write each summary JSON to a local directory
 *   --concurrency <n>        parallel summaries (default: 4)
 *   --limit <n>              summarize at most the first <n> transcripts
 *   --overwrite              re-summarize even if the .summary.json already exists
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import OpenAI from 'openai'
import * as fs from 'fs/promises'
import * as path from 'path'
import { supabaseAdmin } from '../lib/supabase'

const AUDIO_EXT = /\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|webm|mov)$/i
const DEFAULT_SUPABASE_BUCKET = 'transcripts'
const DEFAULT_MODEL = 'gpt-4o'

// USD per 1,000,000 tokens (input, output). Verify at https://openai.com/api/pricing/.
// Used only for the printed cost estimate; an unknown model just prints "n/a".
const MODEL_RATES: Record<string, { in: number; out: number }> = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
}

// Default summarization prompt. This is NOT the FCC archival-log prompt — it's a
// browse/discovery summary for the public spoken-word archive. Override per-run
// with --prompt-file.
const DEFAULT_SUMMARY_PROMPT = `You are summarizing an audio recording from a public radio / spoken-word archive (Pacifica Radio: lectures, interviews, panels, news, and cultural programs) for a browsable public catalog. You are given a speaker-labeled transcript. Write a clear, factual summary that helps someone decide whether to listen.

RULES:
- The "summary" field must be 4 to 8 complete sentences.
- Be neutral and factual. Describe what is actually said: the main subjects, the key arguments or information presented, and who is speaking when they are named.
- Attribute claims and opinions to the speaker who makes them; do not assert them as fact in your own voice.
- Do NOT invent names, dates, affiliations, titles, or any fact not present in the transcript. If something is unclear, omit it rather than guess.
- Do NOT editorialize, praise, criticize, or assess significance, impact, or importance.
- Write plainly for a general reader; it is fine to name the topic directly.
- If the recording is mostly music, a pledge drive, or otherwise has no substantive spoken content, say so briefly in 1-2 sentences instead of padding to 4-8.

Also produce "headline": one short, declarative sentence (about 12 words or fewer) naming the main subject(s). No trailing period needed.

Return ONLY valid JSON, no markdown, no extra text:
{"headline": "string", "summary": "string"}`

interface Args {
  bucket: string | undefined
  prefix: string | undefined
  keys: string[]
  keysFile: string | undefined
  supabaseBucket: string
  model: string
  promptFile: string | undefined
  out: string | undefined
  concurrency: number
  limit: number | undefined
  overwrite: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const limitRaw = get('--limit')
  return {
    bucket: get('--bucket') ?? process.env.R2_BUCKET,
    prefix: get('--prefix'),
    keys: (get('--keys') ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean),
    keysFile: get('--keys-file'),
    supabaseBucket: get('--supabase-bucket') ?? DEFAULT_SUPABASE_BUCKET,
    model: get('--model') ?? DEFAULT_MODEL,
    promptFile: get('--prompt-file'),
    out: get('--out'),
    concurrency: Math.max(1, parseInt(get('--concurrency') ?? '4', 10) || 4),
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
        'R2_SECRET_ACCESS_KEY — or pass --keys/--keys-file to skip R2 listing.',
    )
  }
  return new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } })
}

/** Enumerate audio object keys under a prefix (paginated) — the canonical work-list. */
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

/** Storage object path mirroring the R2 key with the audio extension swapped. */
function storageKey(key: string, ext: string): string {
  return `${key.replace(/\.[^.]+$/, '')}.${ext}`
}

/** Flat local basename for an object key (drops the extension). */
function outBaseName(key: string): string {
  const stripped = key.replace(/\.[^.]+$/, '')
  return stripped.replace(/[\/\\]+/g, '__').replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Does an object already exist in the Supabase bucket? */
async function storageExists(bucket: string, objectPath: string): Promise<boolean> {
  const slash = objectPath.lastIndexOf('/')
  const dir = slash >= 0 ? objectPath.slice(0, slash) : ''
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath
  const { data } = await supabaseAdmin.storage.from(bucket).list(dir, { search: name, limit: 100 })
  return !!data?.some((o) => o.name === name)
}

/** Download a text object from the bucket, or null if it isn't there. */
async function downloadText(bucket: string, objectPath: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(objectPath)
  if (error || !data) return null
  return await data.text()
}

async function uploadJson(bucket: string, objectPath: string, obj: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8')
  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(objectPath, body, { contentType: 'application/json', upsert: true })
  if (error) throw new Error(`upload ${objectPath} failed: ${error.message}`)
}

interface SummaryJson {
  headline: string
  summary: string
}

type OneStatus = 'done' | 'skipped' | 'missing'

interface OneResult {
  key: string
  status: OneStatus
  promptTokens: number
  completionTokens: number
  costUsd: number
}

function costOf(model: string, promptTokens: number, completionTokens: number): number {
  const rate = MODEL_RATES[model]
  if (!rate) return 0
  return (promptTokens / 1e6) * rate.in + (completionTokens / 1e6) * rate.out
}

async function summarizeOne(
  key: string,
  args: Args,
  openai: OpenAI,
  systemPrompt: string,
): Promise<OneResult> {
  const txtPath = storageKey(key, 'txt')
  const summaryPath = storageKey(key, 'summary.json')

  if (!args.overwrite && (await storageExists(args.supabaseBucket, summaryPath))) {
    console.log(`[summarize-r2] skip (exists): ${key}`)
    return { key, status: 'skipped', promptTokens: 0, completionTokens: 0, costUsd: 0 }
  }

  const transcript = await downloadText(args.supabaseBucket, txtPath)
  if (transcript === null || !transcript.trim()) {
    console.warn(`[summarize-r2] no transcript yet: ${key}`)
    return { key, status: 'missing', promptTokens: 0, completionTokens: 0, costUsd: 0 }
  }

  // Retry transient OpenAI errors with exponential backoff (mirrors workers/summarize.ts).
  let response: OpenAI.Chat.Completions.ChatCompletion | null = null
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await openai.chat.completions.create({
        model: args.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Transcript:\n${transcript}` },
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' },
      })
      break
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
      const status = (err as { status?: number })?.status
      if (status && [429, 500, 502, 503].includes(status)) {
        const delay = Math.pow(2, attempt + 1) * 1000
        console.warn(`[summarize-r2] ${key} OpenAI ${status}, retrying in ${delay}ms…`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  if (!response) throw lastError ?? new Error('OpenAI failed after retries')

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('empty response from OpenAI')

  let parsed: SummaryJson
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`invalid JSON from OpenAI: ${content.slice(0, 200)}`)
  }
  if (!parsed.headline?.trim() || !parsed.summary?.trim()) {
    throw new Error(`incomplete summary (missing headline or summary): ${content.slice(0, 200)}`)
  }

  const promptTokens = response.usage?.prompt_tokens ?? 0
  const completionTokens = response.usage?.completion_tokens ?? 0
  const costUsd = costOf(args.model, promptTokens, completionTokens)

  const artifact = {
    source: { bucket: args.supabaseBucket, key, transcript: txtPath },
    model: args.model,
    headline: parsed.headline.trim(),
    summary: parsed.summary.trim(),
    usage: { promptTokens, completionTokens },
    costUsd: Number(costUsd.toFixed(6)),
    generatedAt: new Date().toISOString(),
  }

  await uploadJson(args.supabaseBucket, summaryPath, artifact)
  if (args.out) {
    await fs.writeFile(path.join(args.out, `${outBaseName(key)}.summary.json`), JSON.stringify(artifact, null, 2))
  }

  console.log(`[summarize-r2] ✓ ${key} — ~$${costUsd.toFixed(4)} · "${artifact.headline.slice(0, 60)}"`)
  return { key, status: 'done', promptTokens, completionTokens, costUsd }
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

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set')
  if (!MODEL_RATES[args.model]) {
    console.warn(`[summarize-r2] note: no cost rate for "${args.model}" — cost estimate will read $0.00.`)
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 5 * 60 * 1000 })
  const systemPrompt = args.promptFile
    ? await fs.readFile(args.promptFile, 'utf8')
    : DEFAULT_SUMMARY_PROMPT

  // Work-list: explicit keys, else list the R2 audio bucket (names only).
  const explicitKeys = await loadKeyList(args)
  let keys: string[]
  if (explicitKeys.length) {
    keys = explicitKeys
  } else {
    if (!args.bucket) throw new Error('--bucket (or $R2_BUCKET) is required when listing keys')
    console.log(`[summarize-r2] listing keys in r2://${args.bucket}/${args.prefix ?? ''} …`)
    keys = await listAudioKeys(makeS3(), args.bucket, args.prefix)
  }

  if (args.limit && keys.length > args.limit) {
    console.log(`[summarize-r2] limiting to first ${args.limit} of ${keys.length}`)
    keys = keys.slice(0, args.limit)
  }
  if (!keys.length) {
    console.log('[summarize-r2] no keys matched — nothing to do.')
    return
  }
  if (args.out) await fs.mkdir(args.out, { recursive: true })

  console.log(
    `[summarize-r2] ${keys.length} transcript(s) · model=${args.model} · concurrency=${args.concurrency} · ` +
      `→ supabase://${args.supabaseBucket}/<key>.summary.json${args.out ? ` + local://${path.resolve(args.out)}` : ''}\n`,
  )

  const results = await mapPool(keys, args.concurrency, (key) => summarizeOne(key, args, openai, systemPrompt))

  const ok = results.filter((r) => r.value)
  const failed = results.filter((r) => r.error)
  const done = ok.filter((r) => r.value!.status === 'done')
  const skipped = ok.filter((r) => r.value!.status === 'skipped')
  const missing = ok.filter((r) => r.value!.status === 'missing')
  const totalCost = done.reduce((s, r) => s + r.value!.costUsd, 0)
  const totalIn = done.reduce((s, r) => s + r.value!.promptTokens, 0)
  const totalOut = done.reduce((s, r) => s + r.value!.completionTokens, 0)

  console.log(
    `\n[summarize-r2] done: ${done.length} summarized, ${skipped.length} skipped, ` +
      `${missing.length} no-transcript, ${failed.length} failed.`,
  )
  if (done.length) {
    console.log(
      `[summarize-r2] ${(totalIn / 1e6).toFixed(2)}M in + ${(totalOut / 1e6).toFixed(2)}M out tokens, ` +
        `est. ~$${totalCost.toFixed(2)} on ${args.model}.`,
    )
  }
  if (missing.length) {
    console.warn(`[summarize-r2] no transcript for: ${missing.map((r) => r.item).join(', ')}`)
  }
  if (failed.length) {
    console.error('[summarize-r2] failures:')
    for (const f of failed) console.error(`  ✗ ${f.item}: ${f.error}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('[summarize-r2] fatal:', err instanceof Error ? err.message : err)
  process.exit(1)
})
