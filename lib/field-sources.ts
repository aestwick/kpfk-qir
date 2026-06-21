/**
 * Per-field source provenance engine. Pure logic (no DB/network) so it's shared
 * by the workers (ingest seeds the human copy, summarize records the AI copy)
 * and the dashboard (the per-field Human/AI toggle).
 *
 * Each dual-authored field keeps both the human (Confessor) value and the AI
 * value plus an `active` selector. The episode's flat columns (host/guest/
 * issue_category/summary) always hold the RESOLVED active value so every
 * downstream reader stays unchanged; this layer just decides which copy wins.
 */

/** Fields that can carry both a human and an AI value. headline is AI-only. */
export type DualField = 'host' | 'guest' | 'issue_category' | 'summary'
export const DUAL_FIELDS: DualField[] = ['host', 'guest', 'issue_category', 'summary']

export type FieldSource = 'human' | 'ai' | 'manual'

export interface FieldChoice {
  human: string | null
  ai: string | null
  /** A hand-typed override (from inline edit / the summary editor). */
  manual?: string | null
  /** Which source is currently used for the flat column. */
  active: FieldSource
  /** Set once a human explicitly toggles/edits — the summarizer won't auto-flip it. */
  pinned?: boolean
}

export type FieldSources = Partial<Record<DualField, FieldChoice>>

/**
 * Default winner when BOTH a human and an AI value exist and the field isn't
 * pinned. Categories default to AI (the model catches issues humans under-tag);
 * everything else trusts the human author.
 */
const DEFAULT_WHEN_BOTH: Record<DualField, FieldSource> = {
  host: 'human',
  guest: 'human',
  issue_category: 'ai',
  summary: 'human',
}

const nonEmpty = (s: string | null | undefined): boolean => !!(s && s.trim())

/** The value for a choice's active source (falls back to null). */
export function resolveChoice(choice: FieldChoice | undefined | null): string | null {
  if (!choice) return null
  const v =
    choice.active === 'manual' ? choice.manual
    : choice.active === 'ai' ? choice.ai
    : choice.human
  return v ?? null
}

/** Pick the active source for an un-pinned field given which copies exist. */
function autoActive(field: DualField, choice: FieldChoice): FieldSource {
  if (nonEmpty(choice.manual)) return 'manual'
  const hasHuman = nonEmpty(choice.human)
  const hasAi = nonEmpty(choice.ai)
  if (hasHuman && hasAi) return DEFAULT_WHEN_BOTH[field]
  if (hasAi) return 'ai'
  if (hasHuman) return 'human'
  return 'ai'
}

/**
 * Seed field_sources from the human (Confessor) values at ingest. AI copies are
 * filled in later by the summarizer. Active starts on the human value where one
 * exists; the default policy (e.g. categories → AI) is applied once AI arrives.
 */
export function buildHumanFieldSources(human: Record<DualField, string | null>): FieldSources {
  const fs: FieldSources = {}
  for (const f of DUAL_FIELDS) {
    const hv = human[f] ?? null
    fs[f] = { human: hv, ai: null, active: nonEmpty(hv) ? 'human' : 'ai' }
  }
  return fs
}

/**
 * Record the AI copies (from the summarizer) and resolve each flat value.
 * Un-pinned fields get the default-policy winner; pinned fields keep the human's
 * choice. Works for RSS episodes too (no prior field_sources → human stays null,
 * AI wins — identical to the pre-toggle behavior).
 */
export function applyAi(
  existing: FieldSources | null | undefined,
  ai: Record<DualField, string | null>
): { fieldSources: FieldSources; flat: Record<DualField, string | null> } {
  const fs: FieldSources = {}
  const flat = {} as Record<DualField, string | null>
  for (const f of DUAL_FIELDS) {
    const prev = existing?.[f] ?? { human: null, ai: null, active: 'ai' as FieldSource }
    const choice: FieldChoice = { ...prev, ai: ai[f] ?? null }
    if (!choice.pinned) choice.active = autoActive(f, choice)
    fs[f] = choice
    flat[f] = resolveChoice(choice)
  }
  return { fieldSources: fs, flat }
}

/**
 * Toggle a field to a chosen source (the per-field UI action) or apply a manual
 * edit. Marks the field pinned so a later re-summarize won't override the human's
 * decision. Returns the updated sources and the new resolved value for the flat
 * column.
 */
export function setFieldChoice(
  existing: FieldSources | null | undefined,
  field: DualField,
  source: FieldSource,
  manualValue?: string | null
): { fieldSources: FieldSources; value: string | null } {
  const prev = existing?.[field] ?? { human: null, ai: null, active: source }
  const choice: FieldChoice = { ...prev, active: source, pinned: true }
  if (source === 'manual') choice.manual = manualValue ?? null
  const fs: FieldSources = { ...(existing ?? {}), [field]: choice }
  return { fieldSources: fs, value: resolveChoice(choice) }
}

/** True when a field has both a human and an AI value AND they differ (a real conflict). */
export function hasConflict(choice: FieldChoice | undefined | null): boolean {
  if (!choice) return false
  return nonEmpty(choice.human) && nonEmpty(choice.ai) && choice.human!.trim() !== choice.ai!.trim()
}
