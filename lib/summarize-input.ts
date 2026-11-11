/**
 * What the summarizer is told about an episode besides the transcript. Pure, so
 * the summarize worker (which builds the message) and the Confessor re-sync
 * (which decides whether a producer's edit is worth a re-run) agree on exactly
 * which inputs the model sees.
 *
 * Producer notes come from Confessor: the free-text rundown (`human_summary`)
 * and the FCC issue tags the producer chose (the human copy of issue_category).
 * They are labelled as staff-entered and subordinate to the transcript, and the
 * guidance lives HERE rather than in the editable `summarization_prompt` setting
 * so it holds for every station whatever prompt override they carry.
 */
import type { FieldSources } from './field-sources'

/** Notes beyond this are cut: a pasted full rundown shouldn't dominate cost. */
export const MAX_NOTES_CHARS = 2000

export interface SummarizeInputs {
  host: string | null
  guest: string | null
  /** Producer's free-text notes (Confessor rundown). */
  notes: string | null
  /** Producer's FCC issue tags. */
  issues: string | null
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t ? t : null
}

/** The AI-facing inputs for an episode row. host/guest are the RESOLVED values. */
export function summarizeInputs(ep: {
  host?: string | null
  guest?: string | null
  human_summary?: string | null
  field_sources?: FieldSources | null
}): SummarizeInputs {
  const notes = clean(ep.human_summary)
  return {
    host: clean(ep.host),
    guest: clean(ep.guest),
    notes: notes && notes.length > MAX_NOTES_CHARS ? notes.slice(0, MAX_NOTES_CHARS) + '…' : notes,
    issues: clean(ep.field_sources?.issue_category?.human),
  }
}

/** True when any input the model sees differs (whitespace/empty-insensitive). */
export function summarizeInputsChanged(a: SummarizeInputs, b: SummarizeInputs): boolean {
  return (['host', 'guest', 'notes', 'issues'] as const).some((k) => (a[k] ?? '') !== (b[k] ?? ''))
}

export function buildSummarizeUserMessage(showName: string | null, inputs: SummarizeInputs, transcript: string): string {
  const lines = [
    `Show: ${showName || ''}`,
    `Host(s): ${inputs.host || ''}`,
    `Guest(s): ${inputs.guest || ''}`,
  ]
  if (inputs.notes || inputs.issues) {
    lines.push(
      '',
      'Producer notes (entered by station staff; may be generic text reused for every episode of the show):',
    )
    if (inputs.issues) lines.push(`Issue tags: ${inputs.issues}`)
    if (inputs.notes) lines.push(inputs.notes)
    lines.push(
      '',
      'How to use the producer notes: the transcript is the record of what aired. Use the notes to identify ' +
        'topics and people and to spell names correctly when they clearly refer to someone in the transcript. ' +
        'Do not include anything from the notes that the transcript does not support, and ignore notes that ' +
        'do not match this broadcast.',
    )
  }
  lines.push('', 'Transcript:', transcript)
  return lines.join('\n')
}
