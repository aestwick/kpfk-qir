/**
 * Standalone Supabase-transcripts → descriptive summary job.
 *
 * Reads the speaker-separated `.txt` transcripts that `transcribe-r2` wrote to a
 * Supabase Storage bucket and writes ONE summary artifact per transcript back to
 * the SAME bucket, right next to the captions:
 *
 *   <base>.txt          (input  — produced by transcribe-r2)
 *   <base>.summary.json (output — { summary, speakers[], skip_reason, _meta })
 *
 * Like transcribe-r2 this is a one-off utility: it does NOT touch episode_log,
 * stations, quarters, usage_log, or the QIR pipeline (workers/summarize.ts and
 * its FCC archival-log prompt are unrelated). It walks the bucket, sends each
 * transcript to OpenAI with the archivist prompt, and uploads the result. Cost
 * is computed inline from the API's token usage and printed (not logged to DB).
 *
 * Work-list comes straight from the Supabase bucket (list `.txt` recursively) —
 * no R2 creds, and it reads exactly the keys that exist (so de-accented paths
 * from the transcribe-r2 fix are handled with zero special-casing).
 *
 * Skip-exists makes it idempotent: a transcript whose .summary.json already
 * exists is skipped unless --overwrite. So a 15-file sample then a full run just
 * works — the sample's 15 are skipped on the full pass.
 *
 * Usage (run INSIDE the worker container, which has OPENAI_API_KEY + tsx):
 *
 *   # sample 15, eyeball the output WITHOUT writing anything:
 *   docker exec qir-worker npm run summarize-r2 -- \
 *     --supabase-bucket Transcripts --limit 15 --dry-run
 *
 *   # write summaries for 15:
 *   docker exec qir-worker npm run summarize-r2 -- \
 *     --supabase-bucket Transcripts --limit 15
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (storage) and
 *      OPENAI_API_KEY (summarization).
 *
 * Flags:
 *   --supabase-bucket <name>  Supabase Storage bucket to read/write (default: Transcripts)
 *   --prefix <p>              only transcripts whose key starts with <p>
 *   --limit <n>               summarize at most the first <n> transcripts (sampling)
 *   --concurrency <n>         parallel summarizations (default: 4)
 *   --model <id>              OpenAI model (default: gpt-4o)
 *   --prompt-file <path>      override the baked-in system prompt with a file's contents
 *   --max-chars <n>           truncate transcripts longer than this before sending (default: 240000)
 *   --dry-run                 print summaries to stdout; do NOT upload
 *   --out <dir>               also write each <base>.summary.json to a local directory
 *   --overwrite               re-summarize even if the .summary.json already exists
 */
import * as fs from 'fs/promises'
import * as path from 'path'
import OpenAI from 'openai'
import { supabaseAdmin } from '../lib/supabase'

const DEFAULT_SUPABASE_BUCKET = 'Transcripts'
const DEFAULT_MODEL = 'gpt-4o'
// gpt-4o list price (USD per token). Used only for the printed estimate.
const GPT4O_INPUT_COST_PER_TOKEN = 2.5 / 1_000_000
const GPT4O_OUTPUT_COST_PER_TOKEN = 10 / 1_000_000

const DEFAULT_SUMMARY_PROMPT = `You are an archivist for KPFK, a Pacifica community radio station in Los Angeles.
Your task is to write a factual descriptive summary of an archived radio broadcast
from its transcript. This summary is the canonical record used for search and for
grouping episodes into thematic collections. It is NOT promotional copy and NOT a
compliance document.

INPUTS:
- Episode metadata (may include show title, air date, host(s), guest(s))
- A transcript (machine-generated; may contain errors, especially in proper names)

CORE PRINCIPLE — GROUND EVERYTHING IN THE TRANSCRIPT:
- Summarize only what is actually said in the transcript.
- Do NOT add historical context, dates, biographical facts, significance, or background
  from your own knowledge, even if you recognize the topic, period, or people involved.
- If the transcript references an event or person without explaining it, name it as the
  transcript does and stop. Do not fill in what you know.
- Never guess at or "correct" a proper name. If a name appears garbled or uncertain,
  use it exactly as transcribed or omit it. Do not substitute a real name you think
  was intended.

WHAT TO CAPTURE (this is a search and collection substrate — be specific and dense):
- The actual subjects discussed: topics, events, works, places, named people.
- Claims, arguments, or positions stated by named speakers, attributed by name.
- Concrete specifics a person might search for: names, places, organizations, titles
  of works, the substance of what was argued — not abstract gestures at themes.
- Use the broadcast's own terminology for its subjects — specific names, movement
  names, terms of art the speakers actually use. Do not genericize them into broader
  categories (e.g., keep "the Sanctuary Movement," not "immigration activism").
  Mirror the source's vocabulary, never its tone.
- When multiple distinct segments occur, cover the most substantive ones; name the
  others briefly only if they carry real subject content.

VOICE:
- Neutral and factual, but readable — plain natural prose, not robotic.
- Attribute claims: "[Name] argues that…", "[Name] describes…".
- Do NOT add praise, criticism, political framing, or judgments of importance.
- Do NOT describe significance, impact, implications, or why a topic matters.
- Do NOT narrate structure: no "opens with", "concludes", "the discussion turns to".
- State subjects and claims directly; do not refer to "this episode" or "the program".
- Vary sentence construction; do not collapse every line into "[Name] discusses X."

LENGTH:
- 600–1,000 characters. No fixed sentence count.
- Length follows content: a dense, substantive broadcast earns the upper range; a thin
  one earns the lower. Do not pad a sparse episode to seem substantive.

NON-SUBSTANTIVE / NON-SPEECH EPISODES:
- If the broadcast is primarily music, performance, or readings with little spoken
  discussion, do not invent a summary. State briefly what it is (e.g., "A music
  broadcast of [genre/performer if named]; minimal spoken content.") and set
  "skip_reason".
- If the transcript is too garbled or sparse to summarize reliably, say so plainly and
  set "skip_reason".
- Omit pledge drives, donation appeals, station IDs, promos, and production credits
  from the summary regardless.

OUTPUT — return ONLY valid JSON, no markdown, no extra text:
{"summary":"string","speakers":["string"],"skip_reason":"string or empty"}`

interface Args {
  bucket: string
  prefix: string | undefined
  limit: number | undefined
  concurrency: number
  model: string
  promptFile: string | undefined
  maxChars: number
  dryRun: boolean
  out: string | undefined
  overwrite: boolean
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const num = (flag: string, def: number): number => {
    const raw = get(flag)
    if (raw === undefined) return def
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : def
  }
  const limitRaw = get('--limit')
  return {
    bucket: get('--supabase-bucket') ?? DEFAULT_SUPABASE_BUCKET,
    prefix: get('--prefix'),
    limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 1) : undefined,
    concurrency: Math.max(1, num('--concurrency', 4)),
    model: get('--model') ?? DEFAULT_MODEL,
    promptFile: get('--prompt-file'),
    maxChars: Math.max(1000, num('--max-chars', 240_000)),
    dryRun: argv.includes('--dry-run'),
    out: get('--out'),
    overwrite: argv.includes('--overwrite'),
  }
}

/** The summary object key for a transcript: `<base>.txt` → `<base>.summary.json`. */
function summaryKey(txtKey: string): string {
  return txtKey.replace(/\.txt$/i, '.summary.json')
}

/** Flat local basename for an object key (drops the .txt). */
function outBaseName(txtKey: string): string {
  return txtKey
    .replace(/\.txt$/i, '')
    .replace(/[\/\\]+/g, '__')
    .replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Recursively enumerate `.txt` transcript keys in a Supabase Storage bucket.
 * Supabase `.list(dir)` is one level deep and returns folders as entries with
 * `id === null`; we DFS into those and page each level (limit/offset).
 */
async function listTranscriptKeys(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [prefix.replace(/\/+$/, '')]
  const PAGE = 100
  while (stack.length) {
    const dir = stack.pop()!
    let offset = 0
    while (true) {
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .list(dir, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
      if (error) throw new Error(`Supabase list "${dir}": ${error.message}`)
      if (!data || data.length === 0) break
      for (const item of data) {
        const full = dir ? `${dir}/${item.name}` : item.name
        if (item.id === null) {
          stack.push(full) // folder
        } else if (/\.txt$/i.test(item.name)) {
          out.push(full)
        }
      }
      if (data.length < PAGE) break
      offset += PAGE
    }
  }
  return out
}

/** Does an object already exist in the bucket? (list+search the parent dir.) */
async function storageExists(bucket: string, objectPath: string): Promise<boolean> {
  const slash = objectPath.lastIndexOf('/')
  const dir = slash >= 0 ? objectPath.slice(0, slash) : ''
  const name = slash >= 0 ? objectPath.slice(slash + 1) : objectPath
  const { data } = await supabaseAdmin.storage.from(bucket).list(dir, { search: name, limit: 100 })
  return !!data?.some((o) => o.name === name)
}

async function downloadText(bucket: string, key: string): Promise<string> {
  const { data, error } = await supabaseAdmin.storage.from(bucket).download(key)
  if (error || !data) throw new Error(`Supabase download "${key}": ${error?.message ?? 'no data'}`)
  return await data.text()
}

async function uploadJson(bucket: string, key: string, body: string): Promise<void> {
  const { error } = await supabaseAdmin.storage
    .from(bucket)
    .upload(key, Buffer.from(body, 'utf8'), { contentType: 'application/json', upsert: true })
  if (error) throw new Error(`Supabase upload "${key}": ${error.message}`)
}

interface SummaryShape {
  summary: string
  speakers: string[]
  skip_reason: string
}

/** Coerce the model's JSON into the expected shape; throw if unusable. */
function validate(raw: unknown): SummaryShape {
  if (!raw || typeof raw !== 'object') throw new Error('response is not a JSON object')
  const o = raw as Record<string, unknown>
  const summary = typeof o.summary === 'string' ? o.summary : ''
  const skip_reason = typeof o.skip_reason === 'string' ? o.skip_reason : ''
  const speakers = Array.isArray(o.speakers) ? o.speakers.filter((s): s is string => typeof s === 'string') : []
  if (!summary && !skip_reason) throw new Error('response has neither summary nor skip_reason')
  return { summary, speakers, skip_reason }
}

interface OneResult {
  key: string
  skipped: boolean
  costUsd: number
  inputTokens: number
  outputTokens: number
  hadSkipReason: boolean
}

async function summarizeOne(key: string, args: Args, openai: OpenAI, systemPrompt: string): Promise<OneResult> {
  const destKey = summaryKey(key)

  if (!args.overwrite && !args.dryRun) {
    if (await storageExists(args.bucket, destKey)) {
      console.log(`[summarize-r2] skip (exists): ${destKey}`)
      return { key, skipped: true, costUsd: 0, inputTokens: 0, outputTokens: 0, hadSkipReason: false }
    }
  }

  let transcript = await downloadText(args.bucket, key)
  let truncated = false
  if (transcript.length > args.maxChars) {
    transcript = transcript.slice(0, args.maxChars)
    truncated = true
  }

  // Metadata we actually have for an archive file is the path. Don't fabricate
  // air dates / hosts — the prompt grounds everything in the transcript anyway.
  const base = key.replace(/\.txt$/i, '')
  const title = base.slice(base.lastIndexOf('/') + 1)
  const userMessage = `Title: ${title}
Archive path: ${base}
Transcript:
${transcript}`

  let response: OpenAI.Chat.Completions.ChatCompletion | null = null
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await openai.chat.completions.create({
        model: args.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
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
        console.warn(`[summarize-r2] OpenAI ${status} on ${title}, retrying in ${delay}ms…`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  if (!response) throw lastError ?? new Error('OpenAI failed after retries')

  const content = response.choices[0]?.message?.content
  if (!content) throw new Error('empty response from OpenAI')
  const parsed = validate(JSON.parse(content))

  const inputTokens = response.usage?.prompt_tokens ?? 0
  const outputTokens = response.usage?.completion_tokens ?? 0
  const costUsd = inputTokens * GPT4O_INPUT_COST_PER_TOKEN + outputTokens * GPT4O_OUTPUT_COST_PER_TOKEN

  const out = JSON.stringify(
    {
      ...parsed,
      _meta: {
        source_key: key,
        model: args.model,
        chars: transcript.length,
        truncated,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
      },
    },
    null,
    2,
  )

  const tag = parsed.skip_reason ? `SKIP_REASON: ${parsed.skip_reason}` : `${parsed.summary.length} chars`
  if (args.dryRun) {
    console.log(`\n──────── ${title}${truncated ? ' (truncated)' : ''} ────────`)
    console.log(out)
  } else {
    await uploadJson(args.bucket, destKey, out)
    if (args.out) {
      await fs.writeFile(path.join(args.out, `${outBaseName(key)}.summary.json`), out)
    }
  }
  console.log(
    `[summarize-r2] ${args.dryRun ? '✎' : '✓'} ${title} — ${tag}, ` +
      `${inputTokens}+${outputTokens} tok, ~$${costUsd.toFixed(4)}` +
      (parsed.speakers.length ? ` · speakers: ${parsed.speakers.join(', ')}` : ''),
  )
  return { key, skipped: false, costUsd, inputTokens, outputTokens, hadSkipReason: !!parsed.skip_reason }
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

  const systemPrompt = args.promptFile
    ? (await fs.readFile(args.promptFile, 'utf8')).trim()
    : DEFAULT_SUMMARY_PROMPT

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 5 * 60 * 1000 })

  console.log(`[summarize-r2] listing transcripts in supabase://${args.bucket}/${args.prefix ?? ''} …`)
  let keys = await listTranscriptKeys(args.bucket, args.prefix ?? '')
  keys.sort()
  console.log(`[summarize-r2] ${keys.length} transcript(s) found`)

  if (args.limit && keys.length > args.limit) {
    console.log(`[summarize-r2] limiting to first ${args.limit} of ${keys.length}`)
    keys = keys.slice(0, args.limit)
  }
  if (!keys.length) {
    console.log('[summarize-r2] nothing to do.')
    return
  }
  if (args.out) await fs.mkdir(args.out, { recursive: true })

  console.log(
    `[summarize-r2] ${keys.length} file(s) · model=${args.model} · concurrency=${args.concurrency} · ` +
      `${args.dryRun ? 'DRY-RUN (no upload)' : `→ supabase://${args.bucket}`}\n`,
  )

  const results = await mapPool(keys, args.concurrency, (key) => summarizeOne(key, args, openai, systemPrompt))

  const ok = results.filter((r) => r.value)
  const failed = results.filter((r) => r.error)
  const done = ok.filter((r) => !r.value!.skipped)
  const skipped = ok.filter((r) => r.value!.skipped)
  const skipReasons = done.filter((r) => r.value!.hadSkipReason)
  const totalCost = done.reduce((s, r) => s + r.value!.costUsd, 0)
  const totalIn = done.reduce((s, r) => s + r.value!.inputTokens, 0)
  const totalOut = done.reduce((s, r) => s + r.value!.outputTokens, 0)

  console.log(
    `\n[summarize-r2] done: ${done.length} summarized${args.dryRun ? ' (dry-run, not written)' : ''}, ` +
      `${skipped.length} skipped, ${failed.length} failed.`,
  )
  if (done.length) {
    console.log(
      `[summarize-r2] ${totalIn}+${totalOut} tokens, est. ~$${totalCost.toFixed(2)} · ` +
        `${skipReasons.length} flagged skip_reason (music/sparse/garbled).`,
    )
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
