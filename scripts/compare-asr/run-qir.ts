// ASR comparison, step 2a: run QIR's production transcription path on each
// excerpt from prepare.ts.
//
//   npx tsx scripts/compare-asr/run-qir.ts [--out reports/asr-compare] [--episodes 11015,10892] [--fresh]
//
// What runs is the shipped code, not a re-implementation:
//   - ffmpeg encode with CHUNK_ENCODE_ARGS (lib/transcription/chunking.ts):
//     mono, 16 kHz, 64k AAC M4A — the excerpt is exactly one 15-minute chunk
//   - groqProvider.transcribe (lib/transcription/groq.ts): model from
//     DEFAULT_GROQ_MODEL (turbo), verbose_json, language auto-detected
//   - no vocabulary prompt (vocabulary_hint_enabled is off for KPFK)
//   - correctionsForEpisode + applyCorrections + buildVtt, as workers/transcribe.ts
// Needs GROQ_API_KEY + ffmpeg. Writes <out>/qir/<id>.json. Cached: rerun with --fresh.

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { groqProvider } from '../../lib/transcription/groq'
import { CHUNK_DURATION_SECONDS, CHUNK_ENCODE_ARGS } from '../../lib/transcription/chunking'
import { applyCorrections, type Correction } from '../../lib/transcription/corrections'
import { buildVtt } from '../../lib/transcription/vtt'
import { transcriptionCostPerSecond } from '../../lib/transcription/pricing'
import { DEFAULT_GROQ_MODEL, resolveGroqModel } from '../../lib/groq-models'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const opt = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

interface ManifestEpisode {
  id: number
  show_key: string
  audio: string
  corrections: Correction[]
}

async function main() {
  const out = path.resolve(opt('--out') ?? 'reports/asr-compare')
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'))
  const only = opt('--episodes')?.split(',').map(Number)
  const model = resolveGroqModel(opt('--model') ?? DEFAULT_GROQ_MODEL)
  await fs.mkdir(path.join(out, 'qir'), { recursive: true })
  const gitSha = (await execFileAsync('git', ['rev-parse', 'HEAD']).catch(() => ({ stdout: 'unknown' }))).stdout.trim()

  let billedSec = 0
  for (const ep of manifest.episodes as ManifestEpisode[]) {
    if (only && !only.includes(ep.id)) continue
    const dest = path.join(out, 'qir', `${ep.id}.json`)
    if (!args.includes('--fresh')) {
      try {
        await fs.access(dest)
        console.log(`[qir] ${ep.id}: cached (use --fresh to rerun)`)
        continue
      } catch {
        /* run it */
      }
    }
    const t0 = Date.now()
    const m4a = path.join(out, 'audio', `${ep.id}.m4a`)
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(out, ep.audio), ...CHUNK_ENCODE_ARGS, m4a], { timeout: 600_000 })
    const tEncoded = Date.now()
    const result = await groqProvider.transcribe({
      episodeId: ep.id,
      mp3Url: '',
      diarize: false,
      chunkDurationSec: CHUNK_DURATION_SECONDS,
      getLocalChunks: async () => [m4a],
      model,
    })
    const tDone = Date.now()
    const text = applyCorrections(result.text, ep.corrections)
    const vtt = buildVtt(result.segments, ep.corrections, false)
    // Groq bills a 10-second minimum per request; one request per 15-min chunk.
    const billed = Math.max(10, result.durationSec)
    billedSec += billed
    const cost = billed * transcriptionCostPerSecond('groq', model)
    await fs.writeFile(
      dest,
      JSON.stringify(
        {
          pipeline: 'qir',
          git_sha: gitSha,
          model,
          language: result.language,
          duration_sec: result.durationSec,
          wall_sec: { encode: (tEncoded - t0) / 1000, transcribe: (tDone - tEncoded) / 1000, total: (tDone - t0) / 1000 },
          cost_usd: cost,
          raw_text: result.text,
          text,
          segments: result.segments.map((s) => ({ start: s.startSec, end: s.endSec, text: applyCorrections(s.text.trim(), ep.corrections) })),
          vtt,
        },
        null,
        1,
      ),
    )
    console.log(`[qir] ${ep.id} ${ep.show_key}: ${result.language} · ${result.segments.length} segments · ${((tDone - t0) / 1000).toFixed(1)}s wall · $${cost.toFixed(4)}`)
  }
  if (billedSec) console.log(`[qir] Groq audio billed this run: ${(billedSec / 60).toFixed(1)} min ≈ $${(billedSec * transcriptionCostPerSecond('groq', model)).toFixed(4)}`)
}

main().catch((err) => {
  console.error('[qir] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
