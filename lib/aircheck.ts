// Aircheck: did the hosts announce the station at the hour boundaries, run
// promos, and start/stop cleanly?
//
// Pure logic only — no I/O — so the detection rules are unit-testable;
// scripts/scan-airchecks.ts loads the data and renders the report.
//
// Why a merged wall-clock timeline rather than per-file offsets: the archive
// slices recordings on the hour and half-hour, so a file's own head IS a
// boundary. A legal ID given at 19:59:40 by the outgoing host satisfies the
// 20:00 mark even though it lands in the *previous* file. Scoring each file in
// isolation would report that as missing. So every cue is mapped to absolute
// wall-clock time, the night's files are merged into one timeline, and each
// boundary is scored against a window that spans the file seam.
//
// The merge is per STREAM. KPFK runs a second channel whose archive files carry
// a '2' prefix (2kpfk_…) and overlap the main signal in wall-clock time; merging
// them would let one stream's ID satisfy the other's boundary. Streams are
// scored independently — and only the main broadcast signal carries the FCC
// legal-ID obligation.

/** An episode as the scan sees it (one archive file). */
export interface AircheckEpisode {
  episodeId: number
  showKey: string
  showName: string | null
  category: string | null
  airDate: string
  /** 'HH:MM:SS' — null means the file can't be placed on the clock. */
  airStart: string | null
  durationMin: number | null
  /** Stream identity; files on different streams are scored separately. */
  stream: string
}

/** A timed caption line. */
export interface Cue {
  startMs: number
  endMs: number
  text: string
}

export interface AircheckConfig {
  /** Station ID tokens (stations.station_id_patterns), e.g. ['kpfk','90.7']. */
  idPatterns: string[]
  /** Community of license, for the full legal ID, e.g. ['los angeles']. */
  cityNames: string[]
  /** Seconds either side of a :00 mark that count as "at the top of the hour". */
  topWindowSec: number
  /** Seconds either side of a :30 mark. Station policy, not an FCC rule. */
  bottomWindowSec: number
  /** Also score the :30 marks. */
  checkBottomOfHour: boolean
  /** Silence at the head of a file beyond this reads as a late start. */
  headDeadAirSec: number
  /** Silence at the tail beyond this reads as an early finish. */
  tailDeadAirSec: number
  /** How far into a file to look for the PREVIOUS show's sign-off (bleed). */
  bleedHeadSec: number
  /** How far back from the end to look for this show's own sign-off. */
  signoffTailSec: number
  /** Speech within this many seconds of the file end reads as a hard cut. */
  hardCutSec: number
}

export const DEFAULT_AIRCHECK_CONFIG: AircheckConfig = {
  idPatterns: [],
  cityNames: [],
  topWindowSec: 180,
  bottomWindowSec: 180,
  checkBottomOfHour: true,
  headDeadAirSec: 45,
  tailDeadAirSec: 90,
  bleedHeadSec: 240,
  signoffTailSec: 240,
  hardCutSec: 10,
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Accent folding so "Pacífica" matches "pacifica". Explicit map rather than a
// Unicode property escape: the project's tsconfig target disallows the regex
// /u flag (same constraint lib/vtt.ts works around).
const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a',
  é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u',
  ñ: 'n', ç: 'c',
}

// Punctuation outside ASCII that the ASCII range below can't reach. The Spanish
// openers matter most: "¿Qué" would otherwise keep its "¿" and defeat the \b in
// every pattern here.
const UNICODE_PUNCT = /[¿¡«»“”‘’–—…]/g

/**
 * Lowercase, fold accents, drop punctuation, collapse whitespace. Punctuation
 * removal is what lets a tolerant call-sign match work: Whisper renders the
 * call letters as "KPFK", "K.P.F.K." and "K-P-F-K" interchangeably, and all
 * three normalize to a form the matcher can find.
 */
export function normalizeText(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) out += ACCENTS[ch] ?? ch
  return out
    .replace(UNICODE_PUNCT, ' ')
    .replace(/[!-/:-@[-`{-~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A call-sign pattern tolerant of the spacing punctuation leaves behind.
 * 'kpfk' becomes /k\s*p\s*f\s*k/ so the normalized "k p f k" (from "K.P.F.K.")
 * matches too. Only applied to bare 4-letter call signs; anything else (a
 * frequency, a spelled-out number) is matched literally.
 */
function patternFor(token: string): string {
  const t = normalizeText(token)
  if (/^[a-z]{4}$/.test(t)) return t.split('').map(escapeRe).join('\\s*')
  return escapeRe(t).replace(/\s+/g, '\\s+')
}

/**
 * Which stream an archive file came from. KPFK names main-signal files
 * `kpfk_…` and its second channel `2kpfk_…`; the two overlap in wall-clock time,
 * so they must be scored separately — and only the main signal carries the FCC
 * legal-ID obligation. A filename that doesn't match the station's prefix at all
 * is grouped as 'other' rather than silently folded into the main signal.
 */
export function streamOf(mp3Url: string | null, prefix: string | null): string {
  if (!mp3Url || !prefix) return 'main'
  const file = mp3Url.split('/').pop() ?? ''
  const m = file.match(new RegExp(`^(\\d*)${escapeRe(prefix)}_`, 'i'))
  if (!m) return 'other'
  return m[1] ? `stream ${m[1]}` : 'main'
}

/**
 * The community of license, taken from the station name ("KPFK, Los Angeles").
 * Used to tell a full legal ID from a bare call sign.
 */
export function cityFromStationName(name: string): string[] {
  const parts = name.split(',')
  if (parts.length < 2) return []
  const city = parts.slice(1).join(',').trim()
  return city ? [city] : []
}

// ---------------------------------------------------------------------------
// Station ID detection
// ---------------------------------------------------------------------------

/** How complete an ID is. A legal ID needs call sign + community of license. */
export type IdStrength = 'legal' | 'callsign' | 'frequency' | 'none'

export interface IdMatcher {
  /** Strongest ID form present in the text. */
  strength(text: string): IdStrength
  /** The matched substring, for quoting as evidence. */
  evidence(text: string): string | null
}

/**
 * Build the ID matcher from the station's configured patterns. Splits them into
 * call signs (4 letters) and frequency forms, and adds the Spanish spoken
 * frequency ("noventa punto siete") — KPFK's 8pm-midnight block is
 * Spanish-language, and the configured patterns are English-only.
 */
export function buildIdMatcher(cfg: AircheckConfig): IdMatcher {
  const callTokens = cfg.idPatterns.filter((p) => /^[a-z]{4}$/i.test(p.trim()))
  const freqTokens = cfg.idPatterns.filter((p) => !/^[a-z]{4}$/i.test(p.trim()))

  const callRe = callTokens.length
    ? new RegExp(`\\b(${callTokens.map(patternFor).join('|')})\\b`, 'i')
    : null
  const freqRe = freqTokens.length
    ? new RegExp(`(${freqTokens.map(patternFor).join('|')})`, 'i')
    : null
  const cityRe = cfg.cityNames.length
    ? new RegExp(`(${cfg.cityNames.map(patternFor).join('|')})`, 'i')
    : null

  return {
    strength(text: string): IdStrength {
      const t = normalizeText(text)
      const call = callRe?.test(t) ?? false
      if (call && (cityRe?.test(t) ?? false)) return 'legal'
      if (call) return 'callsign'
      if (freqRe?.test(t) ?? false) return 'frequency'
      return 'none'
    },
    evidence(text: string): string | null {
      const t = normalizeText(text)
      const m = callRe?.exec(t) ?? freqRe?.exec(t) ?? null
      if (!m) return null
      const start = Math.max(0, m.index - 60)
      return t.slice(start, Math.min(t.length, m.index + m[0].length + 60)).trim()
    },
  }
}

// ---------------------------------------------------------------------------
// Promo / sign-off detection
// ---------------------------------------------------------------------------

export type PromoKind = 'tune_in' | 'membership' | 'underwriting' | 'stream_plug'

/**
 * Bilingual promotional-content patterns. English and Spanish are both needed:
 * the evening block is majority Spanish-language.
 *
 * These are deliberately conservative — a phrase has to look like station
 * promotion, not just any mention of a day or a website. The result is a floor
 * on how much promo ran, not a precise count; --verify adds the judgment call.
 */
const PROMO_PATTERNS: Array<{ kind: PromoKind; re: RegExp }> = [
  // Tune-in / upcoming programming
  { kind: 'tune_in', re: /\b(coming up (next|later)|up next|stay tuned|tune in|be sure to (join|tune)|join us (next|again|every)|don t miss|next (week|time) on|catch us every)\b/ },
  { kind: 'tune_in', re: /\b(a continuacion|no te la pierdas|no se lo pierda|no se la pierdan|sintoniza|sintonice|proximamente|acompanenos|los esperamos|todos los (lunes|martes|miercoles|jueves|viernes|sabados|domingos))\b/ },
  // Membership / fund drive
  { kind: 'membership', re: /\b(become a (member|sustainer)|make a (pledge|donation)|your (tax deductible )?(gift|contribution)|support (this station|listener sponsored)|listener sponsored|call in your pledge)\b/ },
  { kind: 'membership', re: /\b(hazte (miembro|socio)|hagase (miembro|socio)|su (donacion|contribucion)|haga su donacion|apoye (a )?(la radio|su radio|esta emisora))\b/ },
  // Underwriting / sponsor credit
  { kind: 'underwriting', re: /\b(brought to you by|sponsored by|support(ed)? (for this program )?(comes )?from|more information (is )?(available )?at|for more information visit)\b/ },
  { kind: 'underwriting', re: /\b(patrocinado por|con el apoyo de|mas informacion en)\b/ },
  // Station / stream self-promotion (web, app, archive)
  { kind: 'stream_plug', re: /\b(kpfk\s*org|kpfa\s*org|kpft\s*org|wpfw\s*org|wbai\s*org|pacifica\s*org|listen (live )?(online|at)|our website|on demand|podcast)\b/ },
  { kind: 'stream_plug', re: /\b(en linea|por internet|nuestra pagina|nuestro sitio)\b/ },
]

export interface PromoHit {
  kind: PromoKind
  atSec: number
  excerpt: string
}

/** Every promo-looking line in the cues, with its time. */
export function detectPromos(cues: Cue[]): PromoHit[] {
  const hits: PromoHit[] = []
  for (const cue of cues) {
    const t = normalizeText(cue.text)
    for (const { kind, re } of PROMO_PATTERNS) {
      if (re.test(t)) {
        hits.push({ kind, atSec: Math.floor(cue.startMs / 1000), excerpt: cue.text.trim().slice(0, 160) })
        break // one hit per cue; kinds overlap and double-counting inflates the floor
      }
    }
  }
  return hits
}

/**
 * A programme sign-off. Used two ways: its ABSENCE at the tail of a file means
 * the show never wrapped (ran into the boundary); its PRESENCE at the head of a
 * file means the *previous* show was still finishing inside this file.
 */
const SIGNOFF_RE =
  /\b(that s (all|it) for( this)? (today|now|tonight|this (week|edition))|thanks for (listening|joining|tuning)|thank you for (listening|joining)|until next (week|time)|see you next (week|time)|we ll be back|this has been|has been (another )?edition|i m your host .{0,40}(signing off|until))\b|\b(y as[ií] llegamos al final|llegamos al final de (otra|esta) (edicion|emision)|se despide|hasta la proxima|hasta (el proximo|la proxima) (semana|programa|emision)|gracias por (acompanarnos|escucharnos|su compania)|fue (otra|una) edicion de|nos escuchamos)\b/

export function hasSignoff(text: string): boolean {
  return SIGNOFF_RE.test(normalizeText(text))
}

/**
 * Does this text begin mid-sentence? Whisper capitalizes the start of a
 * sentence, so a file whose first caption opens on a lowercase word (or a bare
 * conjunction) was recording content already in progress — the hallmark of a
 * file boundary landing in the middle of someone's speech.
 */
export function startsMidSentence(text: string): boolean {
  const raw = text.trim()
  if (!raw) return false
  const first = raw.split(/\s+/)[0]
  // A leading lowercase letter is the primary signal.
  if (/^[a-záéíóúñü]/.test(first)) return true
  // Capitalized-but-continuing: an opening conjunction/preposition.
  return /^(and|but|so|because|which|that|then|y|pero|que|porque|entonces|de|del|la|el|los|las|en|con|para)\b/i.test(first)
}

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

/** 'HH:MM:SS' -> seconds since midnight. */
export function timeToSec(time: string): number {
  const [h, m, s] = time.split(':')
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s ?? '0', 10)
}

/** Seconds since midnight -> 'HH:MM' (wraps past midnight). */
export function secToClock(sec: number): string {
  const s = ((Math.round(sec) % 86400) + 86400) % 86400
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export type BoundaryKind = 'top' | 'bottom'

export interface Boundary {
  kind: BoundaryKind
  /** Seconds since midnight; may exceed 86400 when the night wraps. */
  atSec: number
}

/**
 * The :00 and :30 marks inside [spanStartSec, spanEndSec]. Inclusive of the
 * start: a file beginning at 20:00 opens ON the top of the hour, and that mark
 * is exactly the one the host is supposed to hit. Exclusive of the end, so the
 * closing boundary is scored as the next file's opening one and not twice.
 */
export function enumerateBoundaries(
  spanStartSec: number,
  spanEndSec: number,
  checkBottom: boolean
): Boundary[] {
  const out: Boundary[] = []
  const step = 1800
  const first = Math.ceil(spanStartSec / step) * step
  for (let t = first; t < spanEndSec; t += step) {
    const kind: BoundaryKind = t % 3600 === 0 ? 'top' : 'bottom'
    if (kind === 'bottom' && !checkBottom) continue
    out.push({ kind, atSec: t })
  }
  return out
}

// ---------------------------------------------------------------------------
// Scan results
// ---------------------------------------------------------------------------

export interface TimedCue extends Cue {
  episodeId: number
  /** Absolute seconds since midnight on the night's clock. */
  atSec: number
}

export interface BoundaryResult extends Boundary {
  /** Best ID form found in the window. */
  strength: IdStrength
  /** Episode that owns the mark (the file the mark falls inside). */
  episodeId: number | null
  showKey: string | null
  showName: string | null
  /** Quoted evidence when an ID was found. */
  evidence: string | null
  /**
   * True when the ID was found in a DIFFERENT file than the one that owns the
   * mark — i.e. the outgoing host covered it on their way out.
   */
  coveredByNeighbor: boolean
  /** No cues at all in the window — nothing was transcribed to judge. */
  noCoverage: boolean
}

export type EdgeIssue =
  | 'head_dead_air'
  | 'cold_open'
  | 'prior_show_bleed'
  | 'tail_dead_air'
  | 'hard_cut'
  | 'no_signoff'

export interface EdgeFinding {
  issue: EdgeIssue
  detail: string
  excerpt: string | null
  atSec: number | null
}

export interface EpisodeScan {
  episode: AircheckEpisode
  /** Wall-clock span, seconds since midnight. */
  startSec: number
  endSec: number
  cueCount: number
  edges: EdgeFinding[]
  promos: PromoHit[]
}

export interface StreamNightScan {
  date: string
  stream: string
  boundaries: BoundaryResult[]
  episodes: EpisodeScan[]
}

/**
 * Per-file start/stop hygiene. The file boundaries are fixed by the archive
 * slicer, so everything here measures how well the programme fit its slot.
 */
export function scanEpisodeEdges(
  ep: AircheckEpisode,
  cues: Cue[],
  durationSec: number,
  cfg: AircheckConfig,
  /**
   * Whether durationSec came from the episode's declared duration. When it was
   * inferred from where the captions stop, the tail gap is zero by construction
   * — so the tail checks would fire on every such file. They're skipped instead:
   * without a declared slot length there is no boundary to have run into.
   */
  durationDeclared = true
): EdgeFinding[] {
  const findings: EdgeFinding[] = []
  if (!cues.length) return findings

  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const firstSec = first.startMs / 1000
  const lastEndSec = last.endMs / 1000

  // --- Head ---
  if (firstSec > cfg.headDeadAirSec) {
    findings.push({
      issue: 'head_dead_air',
      detail: `First audible speech ${Math.round(firstSec)}s into the file`,
      excerpt: first.text.trim().slice(0, 160),
      atSec: Math.round(firstSec),
    })
  }

  if (startsMidSentence(first.text)) {
    findings.push({
      issue: 'cold_open',
      detail: 'File opens mid-sentence — content was already in progress at the slice point',
      excerpt: first.text.trim().slice(0, 160),
      atSec: Math.round(firstSec),
    })
  }

  // A sign-off near the TOP of the file belongs to the previous programme: the
  // outgoing show was still wrapping up after the boundary.
  const headCues = sorted.filter((c) => c.startMs / 1000 <= cfg.bleedHeadSec)
  const bleedCue = headCues.find((c) => hasSignoff(c.text))
  if (bleedCue) {
    findings.push({
      issue: 'prior_show_bleed',
      detail: `Previous programme still signing off ${Math.round(bleedCue.startMs / 1000)}s into this file`,
      excerpt: bleedCue.text.trim().slice(0, 160),
      atSec: Math.round(bleedCue.startMs / 1000),
    })
  }

  // --- Tail ---
  // Without a declared slot length there is no tail boundary to judge against.
  if (!durationDeclared || durationSec <= 0) return findings

  const tailGap = durationSec - lastEndSec
  if (tailGap > cfg.tailDeadAirSec) {
    findings.push({
      issue: 'tail_dead_air',
      detail: `Audio ends ${Math.round(tailGap)}s before the slot does`,
      excerpt: null,
      atSec: Math.round(lastEndSec),
    })
  }

  const tailCues = sorted.filter((c) => c.endMs / 1000 >= lastEndSec - cfg.signoffTailSec)
  const signedOff = tailCues.some((c) => hasSignoff(c.text))
  if (!signedOff) {
    if (tailGap <= cfg.hardCutSec) {
      findings.push({
        issue: 'hard_cut',
        detail: 'Still talking when the file ends, with no sign-off — programme ran into the boundary',
        excerpt: last.text.trim().slice(0, 160),
        atSec: Math.round(lastEndSec),
      })
    } else {
      findings.push({
        issue: 'no_signoff',
        detail: 'No recognisable sign-off in the closing minutes',
        excerpt: last.text.trim().slice(0, 160),
        atSec: Math.round(lastEndSec),
      })
    }
  }

  return findings
}

/**
 * Score one stream's night: merge every file's cues onto the wall clock, then
 * judge each :00/:30 mark against a window that spans the file seams.
 *
 * `cuesByEpisode` maps episodeId -> that file's cues (offsets from file start).
 * Episodes without an air_start can't be placed on the clock and are skipped.
 */
export function scanStreamNight(
  date: string,
  stream: string,
  episodes: AircheckEpisode[],
  cuesByEpisode: Map<number, Cue[]>,
  cfg: AircheckConfig
): StreamNightScan {
  const matcher = buildIdMatcher(cfg)

  const placed = episodes
    .filter((e) => e.airStart)
    .map((e) => {
      const startSec = timeToSec(e.airStart as string)
      const cues = cuesByEpisode.get(e.episodeId) ?? []
      // Prefer the declared duration; fall back to how far the captions run so
      // a file with a null duration still gets scored.
      const cueEnd = cues.length ? Math.max(...cues.map((c) => c.endMs)) / 1000 : 0
      const durationDeclared = !!(e.durationMin && e.durationMin > 0)
      const durationSec = durationDeclared ? (e.durationMin as number) * 60 : cueEnd
      return { ep: e, startSec, endSec: startSec + durationSec, durationSec, durationDeclared, cues }
    })
    .sort((a, b) => a.startSec - b.startSec)

  // One timeline for the whole stream, in absolute time.
  const timeline: TimedCue[] = []
  for (const p of placed) {
    for (const c of p.cues) {
      timeline.push({ ...c, episodeId: p.ep.episodeId, atSec: p.startSec + c.startMs / 1000 })
    }
  }
  timeline.sort((a, b) => a.atSec - b.atSec)

  const spanStart = placed.length ? placed[0].startSec : 0
  const spanEnd = placed.length ? Math.max(...placed.map((p) => p.endSec)) : 0
  const boundaries = enumerateBoundaries(spanStart, spanEnd, cfg.checkBottomOfHour)

  const results: BoundaryResult[] = boundaries.map((b) => {
    const window = b.kind === 'top' ? cfg.topWindowSec : cfg.bottomWindowSec
    const inWindow = timeline.filter((c) => Math.abs(c.atSec - b.atSec) <= window)

    // The file that owns the mark: the one whose span contains it. A file
    // starting exactly on the mark owns it (that host is on the air).
    const owner = placed.find((p) => b.atSec >= p.startSec && b.atSec < p.endSec) ?? null

    let best: IdStrength = 'none'
    let evidence: string | null = null
    let foundIn: number | null = null
    const rank: Record<IdStrength, number> = { none: 0, frequency: 1, callsign: 2, legal: 3 }
    for (const c of inWindow) {
      const s = matcher.strength(c.text)
      if (rank[s] > rank[best]) {
        best = s
        evidence = matcher.evidence(c.text)
        foundIn = c.episodeId
      }
    }

    return {
      ...b,
      strength: best,
      episodeId: owner?.ep.episodeId ?? null,
      showKey: owner?.ep.showKey ?? null,
      showName: owner?.ep.showName ?? null,
      evidence,
      coveredByNeighbor: best !== 'none' && foundIn !== null && foundIn !== (owner?.ep.episodeId ?? null),
      noCoverage: inWindow.length === 0,
    }
  })

  const episodeScans: EpisodeScan[] = placed.map((p) => ({
    episode: p.ep,
    startSec: p.startSec,
    endSec: p.endSec,
    cueCount: p.cues.length,
    edges: scanEpisodeEdges(p.ep, p.cues, p.durationSec, cfg, p.durationDeclared),
    promos: detectPromos(p.cues),
  }))

  return { date, stream, boundaries: results, episodes: episodeScans }
}

/** Every date (YYYY-MM-DD) from start to end inclusive. */
export function datesInRange(start: string, end: string): string[] {
  const out: string[] = []
  const cursor = new Date(`${start}T00:00:00Z`)
  const stop = new Date(`${end}T00:00:00Z`)
  while (cursor <= stop) {
    out.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}
