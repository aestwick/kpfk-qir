// Rendering for the aircheck scan (scripts/scan-airchecks.ts). Pure — takes the
// scan result and returns markdown — so the report shape is testable without a
// database, and any other caller can reuse the same aggregation.

import {
  secToClock,
  type EpisodeScan,
  type BoundaryResult,
  type StreamNightScan,
} from './aircheck'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Verdict from the optional --verify pass, carried through into the report. */
export interface AiPromoVerdict {
  promos_present: boolean
  kinds: string[]
  confidence: 'high' | 'medium' | 'low'
  evidence: string
}

export interface ReportData {
  station: { slug: string; name: string }
  window: { from: string; to: string; slotStart: string; slotEnd: string }
  generatedAt: string
  nights: StreamNightScan[]
  aiVerdicts: Record<string, AiPromoVerdict>
  aiRan: boolean
  skipped: { noCaptions: number; noAirStart: number }
}

export const ISSUE_LABELS: Record<string, string> = {
  head_dead_air: 'Late start (dead air at head)',
  cold_open: 'Cold open (starts mid-sentence)',
  prior_show_bleed: 'Previous show bled past the boundary',
  tail_dead_air: 'Ends early (dead air at tail)',
  hard_cut: 'Ran into the boundary (hard cut)',
  no_signoff: 'No sign-off',
}

function showLabel(e: EpisodeScan): string {
  return e.episode.showName ?? e.episode.showKey
}

/**
 * A boundary counts as a genuine miss only when there WERE captions in the
 * window and none of them named the station. A mark with no captions at all
 * (the file failed transcription, or the show is music with nothing to
 * transcribe) is unscannable, not a violation — counting those as misses would
 * blame hosts for a pipeline failure.
 */
export function isMiss(b: BoundaryResult): boolean {
  return b.strength === 'none' && !b.noCoverage
}

/** Marks that could actually be judged (had captions in the window). */
export function scannable(list: BoundaryResult[]): BoundaryResult[] {
  return list.filter((b) => !b.noCoverage)
}

/** Aggregate the per-show boundary scorecard used by both renderers. */
export function showScorecard(nights: StreamNightScan[]) {
  const byShow = new Map<
    string,
    { name: string; stream: string; total: number; scored: number; legal: number; callsign: number; freq: number; none: number; noCov: number }
  >()
  for (const night of nights) {
    for (const b of night.boundaries) {
      if (!b.showKey) continue
      const id = `${night.stream}|${b.showKey}`
      const row =
        byShow.get(id) ??
        { name: b.showName ?? b.showKey, stream: night.stream, total: 0, scored: 0, legal: 0, callsign: 0, freq: 0, none: 0, noCov: 0 }
      row.total++
      if (b.noCoverage) {
        row.noCov++
      } else {
        row.scored++
        if (b.strength === 'legal') row.legal++
        else if (b.strength === 'callsign') row.callsign++
        else if (b.strength === 'frequency') row.freq++
        else row.none++
      }
      byShow.set(id, row)
    }
  }
  return Array.from(byShow.values())
    .filter((r) => r.scored > 0)
    .sort((a, b) => b.none / b.scored - a.none / a.scored || b.scored - a.scored)
}

export function renderMarkdown(r: ReportData): string {
  const L: string[] = []
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '—')

  L.push(`# Aircheck scan — ${r.station.name}`)
  L.push('')
  L.push(`**Daypart:** ${r.window.slotStart}–${r.window.slotEnd} · **Dates:** ${r.window.from} → ${r.window.to}`)
  L.push(`**Generated:** ${r.generatedAt}`)
  L.push('')
  L.push(
    '> Review aid, not a verdict. Findings come from machine transcription: music programming yields sparse ' +
      'captions, and a legal ID played from a station cart can transcribe oddly. Confirm against the audio ' +
      'before raising anything with a host.'
  )
  L.push('')

  const allBoundaries = r.nights.flatMap((n) => n.boundaries)
  const tops = allBoundaries.filter((b) => b.kind === 'top')
  const bottoms = allBoundaries.filter((b) => b.kind === 'bottom')
  const noneOf = (list: BoundaryResult[]) => list.filter(isMiss).length

  L.push('## Summary')
  L.push('')
  L.push('| Mark | Marks | Scorable | Legal ID | Call sign only | Frequency only | No ID | Not scorable |')
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const [label, list] of [['Top of hour (:00)', tops], ['Bottom of hour (:30)', bottoms]] as const) {
    if (!list.length) continue
    const s = scannable(list)
    L.push(
      `| ${label} | ${list.length} | ${s.length} | ${s.filter((b) => b.strength === 'legal').length} | ` +
        `${s.filter((b) => b.strength === 'callsign').length} | ${s.filter((b) => b.strength === 'frequency').length} | ` +
        `**${noneOf(list)}** (${pct(noneOf(list), s.length)}) | ${list.filter((b) => b.noCoverage).length} |`
    )
  }
  L.push('')

  const edges = r.nights.flatMap((n) => n.episodes.flatMap((e) => e.edges.map((f) => f.issue)))
  const edgeCounts = new Map<string, number>()
  for (const i of edges) edgeCounts.set(i, (edgeCounts.get(i) ?? 0) + 1)
  const totalEpisodes = r.nights.reduce((n, x) => n + x.episodes.length, 0)

  L.push(`**Files scanned:** ${totalEpisodes}`)
  if (r.skipped.noCaptions || r.skipped.noAirStart) {
    L.push('')
    L.push(
      `**Not scanned:** ${r.skipped.noCaptions} file(s) with no captions, ` +
        `${r.skipped.noAirStart} with no air time recorded.`
    )
  }
  L.push('')
  L.push('### Start/stop hygiene')
  L.push('')
  L.push('| Issue | Files affected | Share |')
  L.push('|---|---:|---:|')
  for (const [issue, label] of Object.entries(ISSUE_LABELS)) {
    const n = edgeCounts.get(issue) ?? 0
    if (!n) continue
    L.push(`| ${label} | ${n} | ${pct(n, totalEpisodes)} |`)
  }
  L.push('')

  // --- Per-show scorecard ---
  L.push('## Station ID by show')
  L.push('')
  L.push('Ordered worst-first by share of SCORABLE boundaries with no station ID. Marks with no captions\n(failed transcription, or music with nothing to transcribe) are excluded from the rate — they\ncannot be judged either way.')
  L.push('')
  L.push('| Show | Stream | Scorable marks | Legal | Call sign | Freq | **No ID** | Not scorable |')
  L.push('|---|---|---:|---:|---:|---:|---:|---:|')
  for (const s of showScorecard(r.nights)) {
    L.push(
      `| ${s.name} | ${s.stream} | ${s.scored} | ${s.legal} | ${s.callsign} | ${s.freq} | ` +
        `**${s.none}** (${pct(s.none, s.scored)}) | ${s.noCov} |`
    )
  }
  L.push('')

  // --- Promos ---
  L.push('## Promos')
  L.push('')
  L.push('Lexical detection is a floor, not a count — it finds recognisable promo language only.')
  L.push('')
  L.push('| Show | Files | Files with no promo detected | Promos per file (median) |')
  L.push('|---|---:|---:|---:|')
  const promoByShow = new Map<string, { name: string; counts: number[] }>()
  for (const night of r.nights) {
    for (const e of night.episodes) {
      const row = promoByShow.get(e.episode.showKey) ?? { name: showLabel(e), counts: [] }
      row.counts.push(e.promos.length)
      promoByShow.set(e.episode.showKey, row)
    }
  }
  const median = (xs: number[]) => {
    if (!xs.length) return 0
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  for (const row of Array.from(promoByShow.values()).sort(
    (a, b) => b.counts.filter((c) => c === 0).length - a.counts.filter((c) => c === 0).length
  )) {
    const zero = row.counts.filter((c) => c === 0).length
    L.push(`| ${row.name} | ${row.counts.length} | ${zero} (${pct(zero, row.counts.length)}) | ${median(row.counts)} |`)
  }
  L.push('')

  if (r.aiRan) {
    const checked = Object.keys(r.aiVerdicts).length
    const confirmed = Object.values(r.aiVerdicts).filter((v) => !v.promos_present).length
    L.push(
      `**AI promo check:** ${checked} file(s) with no lexical promo hit were re-read; ` +
        `${confirmed} confirmed as carrying no promotional content.`
    )
    L.push('')
  }

  // --- Night by night ---
  L.push('## Night by night')
  L.push('')
  for (const night of r.nights) {
    const dow = WEEKDAYS[new Date(`${night.date}T00:00:00Z`).getUTCDay()]
    L.push(`### ${dow} ${night.date} — ${night.stream}`)
    L.push('')
    L.push('| Mark | Show | Station ID | Note |')
    L.push('|---|---|---|---|')
    for (const b of night.boundaries) {
      const mark = `${secToClock(b.atSec)} ${b.kind === 'top' ? '(top)' : '(bottom)'}`
      const verdict =
        b.strength === 'legal' ? 'legal ID' :
        b.strength === 'callsign' ? 'call sign only' :
        b.strength === 'frequency' ? 'frequency only' : '**none**'
      const notes: string[] = []
      if (b.noCoverage) notes.push('no captions in window')
      if (b.coveredByNeighbor) notes.push('covered by adjacent file')
      if (b.evidence) notes.push(`"${b.evidence.slice(0, 90)}"`)
      L.push(`| ${mark} | ${b.showName ?? b.showKey ?? '—'} | ${verdict} | ${notes.join('; ') || ''} |`)
    }
    L.push('')

    const withIssues = night.episodes.filter((e) => e.edges.length)
    if (withIssues.length) {
      L.push('**Start/stop:**')
      L.push('')
      for (const e of withIssues) {
        for (const f of e.edges) {
          const at = f.atSec !== null ? ` @${Math.floor(f.atSec / 60)}m${String(f.atSec % 60).padStart(2, '0')}s` : ''
          L.push(
            `- \`ep ${e.episode.episodeId}\` **${showLabel(e)}** (${e.episode.airStart?.slice(0, 5)}) — ` +
              `${ISSUE_LABELS[f.issue]}${at}. ${f.detail}.${f.excerpt ? ` _"${f.excerpt}"_` : ''}`
          )
        }
      }
      L.push('')
    }
  }

  return L.join('\n')
}
