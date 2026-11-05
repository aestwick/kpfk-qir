// Pure helpers for QIR curation (workers/generate-qir.ts).
//
// Curation is two passes:
//   1. SELECT — the model sees every candidate as a short snippet (a full
//      quarter in full text would be ~100k tokens) and picks up to N per
//      category.
//   2. REWRITE — each selected entry goes back ON ITS OWN with its FULL
//      summary, and the model writes the filing-ready description.
// Before this split the description was written in pass 1 from the first 200
// characters of each summary, juggling ~60 candidates per category. Filed
// descriptions dropped later guests and segments (Q3 2026 v3, ep 6162: 713-char
// summary → 234-char description missing the host and the second guest), and
// some were attached to the WRONG episode (v3 ep 9142, Alex Cranor on banking,
// filed as "a federal judge blocked Trump's ban on CNN"; 9 such in Q3's drafts).
// One episode per call makes that cross-wiring impossible.

import type { QirEntry } from './qir-format'

export interface CurationRewrite {
  topic?: string
  description?: string
}

export interface ParsedCuration {
  /** Every episode id the model returned, in any category. */
  ids: Set<number>
  /** The model's rewrite per id, when it returned objects rather than bare ids. */
  rewrites: Map<number, CurationRewrite>
}

/**
 * Parse a curation response: `{ "<category>": [ {id, topic, description} | id, … ] }`.
 * Accepts bare numeric ids too, so a prompt that only selects degrades to
 * selection-only instead of yielding zero entries.
 */
export function parseCurationResponse(json: unknown): ParsedCuration {
  const ids = new Set<number>()
  const rewrites = new Map<number, CurationRewrite>()
  if (!json || typeof json !== 'object') return { ids, rewrites }
  for (const items of Object.values(json as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue
    for (const item of items) {
      if (typeof item === 'number') {
        ids.add(item)
      } else if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'number') {
        const it = item as { id: number; topic?: unknown; description?: unknown }
        ids.add(it.id)
        rewrites.set(it.id, {
          topic: typeof it.topic === 'string' ? it.topic : undefined,
          description: typeof it.description === 'string' ? it.description : undefined,
        })
      }
    }
  }
  return { ids, rewrites }
}

/** One selection-pass line per candidate: enough to choose by, not to write from. */
export function selectionLine(e: QirEntry, snippetChars = 200): string {
  return `  ID:${e.episode_id} | ${e.show_name} | ${e.air_date} | Host: ${e.host || 'unknown'} | "${e.headline}" | Guest: ${e.guest || 'none'} | ${(e.summary ?? '').slice(0, snippetChars)}`
}

/**
 * The rewrite-pass input for one category: the shape the curation prompt
 * describes (JSON episode objects), with the FULL summary.
 */
export function rewriteInput(entries: QirEntry[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      id: e.episode_id,
      show_title: e.show_name,
      host: e.host || null,
      guest: e.guest || null,
      air_date: e.air_date,
      air_time: e.start_time || null,
      duration: e.duration ?? null,
      headline: e.headline || null,
      summary: e.summary || '',
      issue_category: e.issue_category,
    })),
    null,
    1
  )
}

export function rewriteUserMessage(entry: QirEntry): string {
  const category = entry.issue_category || 'Uncategorized'
  return `This entry in "${category}" has already been selected for the FCC Quarterly Issues Report. Do not select or drop it: return exactly this one entry under the key "${category}", with its id ${entry.episode_id}, and rewrite its description from its FULL summary according to your rules. Describe only this episode.

${rewriteInput([entry])}`
}

/** The rewrite for `entry` from a rewrite-pass response — only if it came back under THIS entry's id with a non-empty description. */
export function rewriteFor(entry: QirEntry, parsed: ParsedCuration): CurationRewrite | undefined {
  const rw = parsed.rewrites.get(entry.episode_id)
  return rw?.description?.trim() ? rw : undefined
}

/**
 * The filed entry: the rewrite pass's topic and description (written from this
 * episode's full summary alone), else the episode's own stored headline and
 * full summary. Nothing from the selection pass is filed — its topics and
 * descriptions came from snippets and could belong to a different episode.
 */
export function applyCuration(entry: QirEntry, rewrite: CurationRewrite | undefined): QirEntry {
  const headline = rewrite?.topic?.trim() || entry.headline
  const summary = rewrite?.description?.trim() || entry.summary
  return { ...entry, headline, summary }
}

/** Run async tasks with at most `limit` in flight (keeps the rewrite pass inside an HTTP request's budget). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
