// Discover a station's full program list from its archive home page.
//
// The Pacifica archive front-end (generator "Pacifica Archive archiver_9.0.x")
// embeds every program as a <select> <option value="<showkey>">Name</option>.
// Verified identical across KPFK/KPFA/WPFW/KPFT (only the host + plistid differ),
// so one parser enumerates show keys for any station. Names here are display
// seeds only — the canonical name/category come from each feed's <title>/<category>
// at the resolve step (lib/shows-resolve.ts).

const FETCH_TIMEOUT_MS = 30000

// Named HTML entities seen in program titles (Spanish punctuation/accents + the
// XML basics). Numeric entities are handled separately. Anything unmapped is left
// verbatim rather than silently dropped — the feed <title> is the source of truth.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  iquest: '¿', iexcl: '¡',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  agrave: 'à', egrave: 'è', ccedil: 'ç', auml: 'ä', ouml: 'ö', euml: 'ë',
  ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
}

function fromCodePointSafe(cp: number): string {
  try {
    return String.fromCodePoint(cp)
  } catch {
    return ''
  }
}

/** Decode the numeric + named HTML entities that appear in archive program titles. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePointSafe(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED_ENTITIES[name] ?? m)
}

export interface DiscoveredShow {
  key: string
  name: string
}

/**
 * Parse the program list out of an archive home page. Returns one entry per
 * distinct show key, in page order. Names are entity-decoded and whitespace-
 * collapsed; an option whose value isn't a clean key (letters/digits/underscore)
 * is skipped (placeholders like an empty "select a program" row), and a blank
 * name falls back to the key.
 */
export function parseProgramOptions(html: string): DiscoveredShow[] {
  const re = /<option\b[^>]*\bvalue="([^"]*)"[^>]*>([^<]*)/gi
  const seen = new Set<string>()
  const out: DiscoveredShow[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const key = m[1].trim()
    if (!/^[a-z0-9_]+$/i.test(key) || seen.has(key)) continue
    seen.add(key)
    const name = decodeEntities(m[2]).replace(/\s+/g, ' ').trim()
    out.push({ key, name: name || key })
  }
  return out
}

/**
 * Fetch a station's archive home page and return its full program list. The home
 * page is derived from the station's rss_base_url origin (the same archive host
 * ingest pulls feeds from). Throws on a non-OK response so the caller can surface
 * the failure visibly; an empty result (zero options) is left for the caller to
 * treat as "format changed" rather than a valid empty list.
 */
export async function discoverShows(rssBaseUrl: string): Promise<DiscoveredShow[]> {
  const origin = new URL(rssBaseUrl).origin
  const res = await fetch(`${origin}/`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QIR/1.0; +https://qir.kpfk.org)' },
  })
  if (!res.ok) throw new Error(`archive home returned ${res.status}`)
  const html = await res.text()
  return parseProgramOptions(html)
}
