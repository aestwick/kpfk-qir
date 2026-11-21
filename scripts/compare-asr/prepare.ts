// ASR comparison, step 1: pick the episodes, cut identical excerpts, and build
// the per-episode reference name list. READ-ONLY against production: only
// SELECTs (service-role client), nothing is written to the database.
//
//   npx tsx scripts/compare-asr/prepare.ts [--episodes 11015,10892] [--start 120] [--duration 900] [--out reports/asr-compare]
//
// Database access is plain read-only SQL, either through the Claude cloud
// session's read-only Supabase MCP endpoint (default; see scripts/claude/sbq.sh)
// or `--db psql`, which uses DATABASE_URL (run it with a read-only role).
// The loaders mirror lib/transcription/store.ts; the scoping itself is the
// production pure function (correctionsForEpisode / showGroupKey).
//
// Output (gitignored): <out>/manifest.json and <out>/audio/<id>.mp3 — the
// excerpt, cut from the archive MP3 with stream copy (no re-encode), so both
// pipelines start from the same bytes. QIR re-encodes it the production way
// (run-qir.ts); Faster-Whisper decodes the MP3 itself, as Pacifica does.

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'
import { episodeHumanNames } from '../../lib/transcription/store'
import { correctionsForEpisode, type Correction } from '../../lib/transcription/corrections'
import { splitPersonNames } from '../../lib/transcription/names'
import { resolveShowDisplayName, showGroupKey } from '../../lib/shows'

const execFileAsync = promisify(execFile)
const args = process.argv.slice(2)
const opt = (f: string) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

interface EpisodeRow {
  id: number
  show_key: string
  air_date: string
  air_start: string | null
  duration: number | null
  mp3_url: string
  human_summary: string | null
  confessor_meta: unknown
  field_sources: Record<string, { human?: unknown; ai?: unknown }> | null
}
interface ShowRow {
  key: string
  show_name: string | null
  feed_name: string | null
  display_name: string | null
  show_group: string | null
  category: string | null
}

const MCP_URL = `https://mcp.supabase.com/mcp?project_ref=${process.env.QIR_SUPABASE_REF ?? 'czjhwhfqohpmwprhasve'}&read_only=true`

/** Read-only SQL through the cloud session's proxy-injected Supabase MCP
 *  (server-enforced read_only=true). curl, because it honours HTTPS_PROXY. */
async function mcpQuery<T>(query: string): Promise<T[]> {
  const H = ['-H', 'Content-Type: application/json', '-H', 'Accept: application/json, text/event-stream']
  const init = await execFileAsync('curl', ['-s', '-m', '30', '-D', '-', '-o', '/dev/null', '-X', 'POST', MCP_URL, ...H, '-d',
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'compare-asr', version: '1' } } })])
  const sidHdr = /^mcp-session-id:\s*(\S+)/im.exec(init.stdout)?.[1]
  if (!sidHdr) throw new Error('MCP initialize failed (not in a Claude cloud session? use --db psql)')
  const S = ['-H', `Mcp-Session-Id: ${sidHdr}`]
  await execFileAsync('curl', ['-s', '-m', '30', '-X', 'POST', MCP_URL, ...H, ...S, '-d', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })])
  const res = await execFileAsync('curl', ['-s', '-m', '120', '-X', 'POST', MCP_URL, ...H, ...S, '-d',
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'execute_sql', arguments: { query } } })], { maxBuffer: 64 << 20 })
  const body = res.stdout.startsWith('{') ? res.stdout : (res.stdout.match(/^data: (.*)$/m)?.[1] ?? '')
  const parsed = JSON.parse(body)
  const text: string = parsed.result?.content?.[0]?.text ?? ''
  if (parsed.error || parsed.result?.isError) throw new Error(`SQL failed: ${JSON.stringify(parsed.error ?? text).slice(0, 400)}`)
  let payload = text
  try {
    payload = JSON.parse(text).result ?? text
  } catch {
    /* already plain */
  }
  const m = /<untrusted-data-[^>]+>\n([\s\S]*?)\n<\/untrusted-data/.exec(payload)
  return JSON.parse(m ? m[1] : payload) as T[]
}

/** Same, through psql + DATABASE_URL (e.g. on the VPS). */
async function psqlQuery<T>(query: string): Promise<T[]> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for --db psql')
  const res = await execFileAsync('psql', [process.env.DATABASE_URL, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `set default_transaction_read_only = on; select coalesce(json_agg(t), '[]') from (${query}) t`], { maxBuffer: 64 << 20 })
  return JSON.parse(res.stdout.trim().split('\n').pop() ?? '[]') as T[]
}

interface DefaultSet {
  station: string
  start_sec: number
  duration_sec: number
  episodes: Array<{ id: number; role: string }>
}

/** Capitalised 2–4 word runs in free text ("Carter Lavin", "Robert E. Williams") —
 *  a crude name finder for the Confessor rundown, which is prose. */
function namesInProse(html: string | null): string[] {
  if (!html) return []
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;?|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
  const re = /\b([A-Z][a-zà-ÿ'’-]+(?:\s+(?:[A-Z]\.|[A-Z][a-zà-ÿ'’-]+|de|del|la|van|von)){1,3})\b/g
  const out = new Set<string>()
  for (const m of text.matchAll(re)) {
    const n = m[1].trim()
    if (/^(The|A|An|In|On|At|And|But|How|What|Why|When|This|That|Professor|Assistant|Department|University|College)\b/.test(n)) continue
    if (/\b(University|College|Department|Institute|Center|School|Press|Radio|State)\b/.test(n)) continue
    // A job title glued to the front ("Economist Michael Smith") is not part of the name.
    out.add(n.replace(/^(Economist|Historian|Author|Journalist|Dr|Pianist|Composer|Professor|Senator|Congressman|Congresswoman|Rep)\s+/, ''))
  }
  return [...out]
}

function confessorNames(meta: unknown): string[] {
  if (!Array.isArray(meta)) return []
  const out: string[] = []
  for (const pf of meta as Array<Record<string, unknown>>) {
    for (const k of ['pf_host', 'pf_gname']) {
      if (typeof pf[k] === 'string') out.push(...splitPersonNames(pf[k] as string))
    }
  }
  return out
}

async function main() {
  const defaults: DefaultSet = JSON.parse(await fs.readFile(path.join(__dirname, 'episodes.json'), 'utf8'))
  const ids = opt('--episodes')?.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite) ?? defaults.episodes.map((e) => e.id)
  const startSec = Number(opt('--start') ?? defaults.start_sec)
  const durationSec = Number(opt('--duration') ?? defaults.duration_sec)
  const out = path.resolve(opt('--out') ?? 'reports/asr-compare')
  await fs.mkdir(path.join(out, 'audio'), { recursive: true })

  const sql = opt('--db') === 'psql' ? psqlQuery : mcpQuery
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`
  const [station] = await sql<{ id: string }>(`select id from stations where slug = ${lit(defaults.station)}`)
  if (!station) throw new Error(`station ${defaults.station} not found`)
  const sid = lit(station.id)
  const eps = await sql<EpisodeRow>(
    `select id, show_key, air_date, air_start, duration, mp3_url, human_summary, confessor_meta, field_sources
       from episode_log where station_id = ${sid} and id in (${ids.join(',')})`,
  )
  const shows = await sql<ShowRow>(
    `select key, show_name, feed_name, display_name, show_group, category from show_keys where station_id = ${sid}`,
  )
  const showByKey = new Map(shows.map((s) => [s.key, s]))
  const groupOf = (k: string) => {
    const row = showByKey.get(k)
    return row ? showGroupKey(row) : k.toLowerCase()
  }
  // Same rows, same order as lib/transcription/store.ts#loadCorrectionRules / loadVocabulary.
  const corrections: Correction[] = (
    await sql<{ wrong: string; correct: string; case_sensitive: boolean; is_regex: boolean; episode_id: number | null; show_key: string | null }>(
      `select wrong, correct, case_sensitive, is_regex, episode_id, show_key from transcript_corrections
        where station_id = ${sid} and active order by id`,
    )
  ).map((c) => ({ wrong: c.wrong, correct: c.correct, caseSensitive: !!c.case_sensitive, isRegex: !!c.is_regex, episodeId: c.episode_id, showKey: c.show_key }))
  const vocabRows = await sql<{ show_key: string | null; name: string }>(
    `select show_key, name from transcript_vocabulary where station_id = ${sid} and active order by id`,
  )
  const stationTerms = vocabRows.filter((r) => !r.show_key).map((r) => r.name)
  const namesForShow = (k: string) => vocabRows.filter((r) => r.show_key && groupOf(r.show_key) === groupOf(k)).map((r) => r.name)

  const roles = new Map(defaults.episodes.map((e) => [e.id, e.role]))
  const manifest = {
    created_at: new Date().toISOString(),
    station: defaults.station,
    start_sec: startSec,
    duration_sec: durationSec,
    episodes: [] as unknown[],
  }

  for (const id of ids) {
    const ep = eps.find((e) => e.id === id)
    if (!ep) {
      console.warn(`[prepare] episode ${id} not found for ${defaults.station} — skipped`)
      continue
    }
    const show = showByKey.get(ep.show_key)
    const showName = show ? resolveShowDisplayName(show, ['KPFK - ', 'KPFK -']) : ep.show_key
    const category = show?.category ?? null
    const audio = path.join(out, 'audio', `${id}.mp3`)
    try {
      await fs.access(audio)
    } catch {
      console.log(`[prepare] ${id} ${ep.show_key}: cutting ${startSec}s +${durationSec}s from ${ep.mp3_url}`)
      await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-rw_timeout', '60000000', '-ss', String(startSec), '-t', String(durationSec), '-i', ep.mp3_url, '-c', 'copy', '-map_metadata', '-1', audio], { timeout: 600_000 })
    }

    const human = new Set<string>([
      ...episodeHumanNames(ep.field_sources),
      ...confessorNames(ep.confessor_meta),
      ...namesInProse(ep.human_summary),
    ])
    const vocabulary = new Set<string>([...namesForShow(ep.show_key), ...stationTerms])
    const ai = new Set<string>()
    for (const f of ['host', 'guest']) {
      const v = (ep.field_sources as Record<string, { ai?: unknown }> | null)?.[f]?.ai
      if (typeof v === 'string') splitPersonNames(v).forEach((n) => ai.add(n))
    }

    manifest.episodes.push({
      id,
      role: roles.get(id) ?? '',
      show_key: ep.show_key,
      show_name: showName,
      category,
      air_date: ep.air_date,
      air_start: ep.air_start,
      duration_min: ep.duration,
      mp3_url: ep.mp3_url,
      audio: path.relative(out, audio),
      // Pacifica forces Spanish for the "Español" catalog category, else English.
      pacifica_language: category === 'Español' ? 'es' : 'en',
      reference: {
        human: [...human],
        vocabulary: [...vocabulary],
        show_name: showName,
        // AI copies were extracted FROM QIR's own transcript — biased toward QIR;
        // scored separately, never in the headline number.
        ai_extracted: [...ai].filter((n) => !human.has(n) && !vocabulary.has(n)),
      },
      corrections: correctionsForEpisode(corrections, id, ep.show_key, groupOf).map((c) => ({
        wrong: c.wrong,
        correct: c.correct,
        caseSensitive: c.caseSensitive,
        isRegex: c.isRegex,
        episodeId: c.episodeId ?? null,
        showKey: c.showKey ?? null,
      })),
    })
  }

  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(`[prepare] wrote ${manifest.episodes.length} episodes → ${path.join(out, 'manifest.json')}`)
}

main().catch((err) => {
  console.error('[prepare] failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
