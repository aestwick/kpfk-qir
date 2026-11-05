// Names benchmark: does the vocabulary hint (and the correction rules) make
// transcripts spell known names right — without inventing speech on music?
//
// Runs a FIXED episode set (scripts/data/names-benchmark.json): one 15-minute
// chunk per episode, cut exactly like production (lib/transcription/chunking),
// transcribed by the production Groq provider twice — without and with the
// hint — then scored against human-confirmed names (lib/transcription/benchmark).
// Needs only GROQ_API_KEY and ffmpeg; no database. Costs ~$0.30 per full run
// on turbo (15 chunks × 2 runs × 15 min); results are cached per run so
// --rescore re-scores for free.
//
// Usage:
//   npm run benchmark-names                 # run (uses cache when present)
//   npm run benchmark-names -- --rescore    # score cached runs only, no API
//   npm run benchmark-names -- --fresh      # ignore cache, re-transcribe
//   npm run benchmark-names -- --model whisper-large-v3
// Output: terminal summary + reports/names-benchmark/<model>/report.md

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { groqProvider } from '../lib/transcription/groq'
import { CHUNK_DURATION_SECONDS, CHUNK_ENCODE_ARGS } from '../lib/transcription/chunking'
import { applyCorrections, buildVariantRule, correctionsForEpisode, type Correction } from '../lib/transcription/corrections'
import { buildVocabularyPrompt } from '../lib/transcription/vocabulary'
import { accuracy, countPhrase, lostWords, scoreNames, type NameExpectation, type NameScore } from '../lib/transcription/benchmark'
import { transcriptionCostPerSecond } from '../lib/transcription/pricing'
import { DEFAULT_GROQ_MODEL, resolveGroqModel } from '../lib/groq-models'
import type { TranscriptionResult } from '../lib/transcription/types'

const execFileAsync = promisify(execFile)

interface Episode {
  id: number
  show: string
  kind: 'talk' | 'music'
  chunk: number
  mp3: string
  hint: string[]
  names: NameExpectation[]
}
interface Fixture {
  stationTerms: string[]
  episodes: Episode[]
  rules: {
    existing: Correction[]
    suggested: Array<{ show: string; variant: string; correct: string }>
  }
}

const args = process.argv.slice(2)
const flag = (f: string) => args.includes(f)
const opt = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const MODEL = resolveGroqModel(opt('--model') ?? DEFAULT_GROQ_MODEL)
const OUT = path.join(process.cwd(), 'reports', 'names-benchmark', MODEL)

async function cutChunk(ep: Episode, dir: string): Promise<string> {
  const out = path.join(dir, `ep${ep.id}_c${ep.chunk}.m4a`)
  try {
    await fs.access(out)
    return out
  } catch {
    /* not cached */
  }
  await execFileAsync('ffmpeg', [
    '-y', '-ss', String(ep.chunk * CHUNK_DURATION_SECONDS), '-t', String(CHUNK_DURATION_SECONDS),
    '-i', ep.mp3, ...CHUNK_ENCODE_ARGS, out,
  ], { timeout: 600_000 })
  return out
}

async function transcribe(ep: Episode, arm: 'A' | 'B', prompt: string, audioDir: string): Promise<{ result: TranscriptionResult; cached: boolean }> {
  const cache = path.join(OUT, `ep${ep.id}_${arm}.json`)
  if (!flag('--fresh')) {
    try {
      return { result: JSON.parse(await fs.readFile(cache, 'utf8')), cached: true }
    } catch {
      if (flag('--rescore')) throw new Error(`no cached run for ep ${ep.id} arm ${arm} (run without --rescore first)`)
    }
  }
  const chunk = await cutChunk(ep, audioDir)
  const result = await groqProvider.transcribe({
    episodeId: ep.id,
    mp3Url: ep.mp3,
    diarize: false,
    chunkDurationSec: CHUNK_DURATION_SECONDS,
    getLocalChunks: async () => [chunk],
    model: MODEL,
    ...(prompt ? { prompt } : {}),
  })
  await fs.writeFile(cache, JSON.stringify({ ...result, prompt }, null, 1))
  return { result, cached: false }
}

const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`)
const sum = (scores: NameScore[]) => scores.reduce((a, s) => ({ right: a.right + s.right, wrong: a.wrong + s.wrong }), { right: 0, wrong: 0 })

async function main() {
  const fixture: Fixture = JSON.parse(await fs.readFile(path.join(__dirname, 'data', 'names-benchmark.json'), 'utf8'))
  await fs.mkdir(OUT, { recursive: true })
  const audioDir = path.join(os.tmpdir(), 'qir-names-benchmark')
  await fs.mkdir(audioDir, { recursive: true })

  const existing = fixture.rules.existing
  const suggested: Correction[] = fixture.rules.suggested.map((s) => ({ ...buildVariantRule(s.variant, s.correct), showKey: s.show }))

  let billedSec = 0
  const lines: string[] = []
  const totals = { today: [] as NameScore[], rules: [] as NameScore[], hint: [] as NameScore[], both: [] as NameScore[] }
  let talkLost = 0
  const musicRows: string[] = []

  lines.push(`# Names benchmark — ${MODEL}`, '', `Run ${new Date().toISOString()}. One 15-minute chunk per episode. Accuracy = of the times a known name came out, how often it was spelled right.`, '')
  lines.push('## Talk shows', '', '| Episode | Show | Today (no hint, current rules) | + suggested rules | Hint | Hint + rules | Words lost to hint | Cues A→B |', '|---|---|---|---|---|---|---|---|')

  for (const ep of fixture.episodes) {
    const prompt = buildVocabularyPrompt({ stationTerms: fixture.stationTerms, showNames: ep.hint, episodeNames: [] })
    const a = await transcribe(ep, 'A', '', audioDir)
    const b = await transcribe(ep, 'B', prompt, audioDir)
    if (!a.cached) billedSec += Math.max(10, a.result.durationSec)
    if (!b.cached) billedSec += Math.max(10, b.result.durationSec)

    const rulesFor = (extra: boolean) => correctionsForEpisode(extra ? [...existing, ...suggested] : existing, ep.id, ep.show)
    const text = (r: TranscriptionResult, extra: boolean) => applyCorrections(r.text, rulesFor(extra))

    if (ep.kind === 'music') {
      const hintMentions = (t: string) => ep.hint.concat(fixture.stationTerms).reduce((n, h) => n + countPhrase(t, h), 0)
      musicRows.push(
        `| ${ep.id} | ${ep.show} | ${hintMentions(a.result.text)} | ${hintMentions(b.result.text)} | ${lostWords(a.result.text, b.result.text)} | ${a.result.segments.length} → ${b.result.segments.length} |`,
      )
      continue
    }

    const sToday = scoreNames(text(a.result, false), ep.names)
    const sRules = scoreNames(text(a.result, true), ep.names)
    const sHint = scoreNames(text(b.result, false), ep.names)
    const sBoth = scoreNames(text(b.result, true), ep.names)
    totals.today.push(...sToday)
    totals.rules.push(...sRules)
    totals.hint.push(...sHint)
    totals.both.push(...sBoth)
    const lost = lostWords(a.result.text, b.result.text)
    talkLost += lost
    const cell = (s: NameScore[]) => {
      const t = sum(s)
      return `${pct(accuracy(s))} (${t.right}✓ ${t.wrong}✗)`
    }
    lines.push(`| ${ep.id} | ${ep.show} | ${cell(sToday)} | ${cell(sRules)} | ${cell(sHint)} | ${cell(sBoth)} | ${lost} | ${a.result.segments.length} → ${b.result.segments.length} |`)
    console.log(`[benchmark] ${ep.show}: today ${pct(accuracy(sToday))} → rules ${pct(accuracy(sRules))} · hint ${pct(accuracy(sHint))} · both ${pct(accuracy(sBoth))} · lost ${lost}`)
  }

  const row = (label: string, s: NameScore[]) => {
    const t = sum(s)
    return `| ${label} | **${pct(accuracy(s))}** | ${t.right} | ${t.wrong} |`
  }
  lines.push(
    '',
    '## Talk shows — overall',
    '',
    '| Setup | Names spelled right | Right | Wrong |',
    '|---|---|---|---|',
    row('Today: no hint, current rules', totals.today),
    row('Approve the suggested rules', totals.rules),
    row('Turn on the hint (current rules)', totals.hint),
    row('Hint + suggested rules', totals.both),
    '',
    `Real speech replaced by the hint across all talk chunks: **${talkLost} words** (runs of 12+ words that changed).`,
    '',
    '## Music — the hint is never sent to music in production',
    '',
    'Forced here anyway, to show what would happen if a music show were mis-tagged as talk (the prompt-echo guard is on).',
    '',
    '| Episode | Show | Hint names in output, no hint | …with hint forced | Words changed (12+ runs) | Segments A→B |',
    '|---|---|---|---|---|---|',
    ...musicRows,
    '',
    `Groq audio billed this run: ${(billedSec / 60).toFixed(1)} min ≈ $${(billedSec * transcriptionCostPerSecond('groq', MODEL)).toFixed(3)}.`,
  )
  const report = lines.join('\n') + '\n'
  await fs.writeFile(path.join(OUT, 'report.md'), report)
  console.log('\n' + report)
}

main().catch((err) => {
  console.error('[benchmark] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
