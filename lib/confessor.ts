import { ConfessorPubfile } from './types'

/**
 * Client for the Pacifica "Confessor" archive API (see references/api-reference.html
 * and references/_nu_do_api.php). Each station runs its own host and the whole
 * API is dispatched off a single `?req=<endpoint>` query param.
 *
 * We use exactly one endpoint here: `?req=fil&id=<slug>&num=<n>` — "recent
 * archived episodes (MP3s) for a slug" — because it's the only one that returns
 * a downloadable MP3 *together with* the human-entered `pubfile` metadata
 * (host, guest, topic, FCC issue tags, free-text notes). That human metadata is
 * the whole reason to prefer Confessor over RSS.
 */

/** One row from `?req=fil` — an archived airing plus its human pubfile segments. */
export interface ConfessorFilRow {
  pubfile?: ConfessorPubfile[]
  idkey?: string
  title?: string
  category?: string
  producer?: string
  /** Full MP3 URL, or the literal string "expired" once past the archive window. */
  mp3?: string
  day?: string
  date?: string
  time?: string
  /** Air time as a unix timestamp (seconds). Ground truth for date/time fields. */
  def_time?: number
  expires?: number
  /** Length in seconds. */
  lsecs?: number
  length?: string
  type?: string
  txt?: string
}

/**
 * Several Confessor endpoints prepend PHP notices/warnings before the JSON body
 * (documented quirk — see api-reference.html "Output encoding"). A strict
 * JSON.parse would choke, so we trim to the first `[` or `{` before parsing.
 */
export function parseLooseJson<T>(text: string): T {
  const start = text.search(/[[{]/)
  if (start === -1) throw new Error('no JSON payload found in response')
  return JSON.parse(text.slice(start)) as T
}

/** Build a Confessor API URL: `<base>?req=<req>&<params>&json=1`. */
export function confessorUrl(
  base: string,
  req: string,
  params: Record<string, string | number> = {}
): string {
  const u = new URL(base)
  u.searchParams.set('req', req)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  u.searchParams.set('json', '1')
  return u.toString()
}

/**
 * Fetch recent archived episodes for a show slug. Throws on network/HTTP/parse
 * failure so the caller can fall back to RSS; resolves to `[]` only when the
 * show genuinely has no archived episodes.
 */
export async function fetchConfessorEpisodes(
  base: string,
  slug: string,
  num: number
): Promise<ConfessorFilRow[]> {
  const url = confessorUrl(base, 'fil', { id: slug, num })
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) {
    throw new Error(`Confessor fil ${slug}: HTTP ${response.status}`)
  }
  const text = await response.text()
  if (!text.trim()) return [] // empty body = no episodes (not an error)
  const parsed = parseLooseJson<ConfessorFilRow[] | ConfessorFilRow>(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const dedupe = (vals: (string | undefined)[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of vals) {
    const s = v?.trim()
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase())
      out.push(s)
    }
  }
  return out
}

export interface PubfileProjection {
  /** First non-empty host across segments. */
  host: string | null
  /** Distinct guest names, comma-joined. */
  guest: string | null
  /** Distinct FCC issue tags (issue1..3 across segments), comma-joined. */
  issueCategory: string | null
  /** Human narrative woven from topics + notes across all segments; null if none. */
  humanSummary: string | null
}

/**
 * Project the (possibly multi-segment) pubfile onto our structured columns.
 * Robust to whatever the human filled in — a lone guest, just a topic, or a
 * full multi-segment rundown all survive: the raw array is stored separately
 * (lossless), and this only synthesizes the convenience projections.
 */
export function projectPubfile(pubfile: ConfessorPubfile[] | undefined): PubfileProjection {
  const segments = pubfile ?? []

  const host =
    dedupe(segments.map((s) => s.pf_host))[0] ?? null
  const guests = dedupe(segments.map((s) => s.pf_gname))
  const issues = dedupe(segments.flatMap((s) => [s.pf_issue1, s.pf_issue2, s.pf_issue3]))

  // Build a readable narrative from each segment that carries a guest, topic,
  // or notes. "<guest> — <topic>: <notes>", dropping any empty piece.
  const blocks: string[] = []
  for (const s of segments) {
    const head = [s.pf_gname?.trim(), s.pf_gtopic?.trim()].filter(Boolean).join(' — ')
    const notes = s.pf_notes?.trim()
    const block = [head, notes].filter(Boolean).join(': ')
    if (block) blocks.push(block)
  }

  return {
    host,
    guest: guests.length ? guests.join(', ') : null,
    issueCategory: issues.length ? issues.join(', ') : null,
    humanSummary: blocks.length ? blocks.join('\n\n') : null,
  }
}
