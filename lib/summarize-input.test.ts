import { describe, it, expect } from 'vitest'
import { buildSummarizeUserMessage, summarizeInputs, summarizeInputsChanged, MAX_NOTES_CHARS } from './summarize-input'

describe('summarizeInputs', () => {
  it('takes resolved host/guest, the human rundown and the human issue tags', () => {
    const i = summarizeInputs({
      host: 'Marlene Braga',
      guest: ' Shirin Neshat ',
      human_summary: 'Artists in exile.',
      field_sources: { issue_category: { human: 'Arts & Culture', ai: 'Immigration', active: 'ai' } },
    })
    expect(i).toEqual({ host: 'Marlene Braga', guest: 'Shirin Neshat', notes: 'Artists in exile.', issues: 'Arts & Culture' })
  })

  it('never feeds the AI copy of issue tags back to the AI', () => {
    const i = summarizeInputs({ field_sources: { issue_category: { human: null, ai: 'Health', active: 'ai' } } })
    expect(i.issues).toBeNull()
  })

  it('caps long notes', () => {
    const i = summarizeInputs({ human_summary: 'x'.repeat(MAX_NOTES_CHARS + 500) })
    expect(i.notes!.length).toBe(MAX_NOTES_CHARS + 1)
  })
})

describe('buildSummarizeUserMessage', () => {
  it('is unchanged from the old shape when there are no producer notes', () => {
    const msg = buildSummarizeUserMessage('The Road', { host: 'A', guest: null, notes: null, issues: null }, 'hello')
    expect(msg).toBe('Show: The Road\nHost(s): A\nGuest(s): \n\nTranscript:\nhello')
    expect(msg).not.toContain('Producer notes')
  })

  it('adds labelled, transcript-subordinate producer notes when present', () => {
    const msg = buildSummarizeUserMessage('The Road', { host: 'A', guest: 'B', notes: 'Rundown here', issues: 'Health' }, 'T')
    expect(msg).toContain('Producer notes')
    expect(msg).toContain('Issue tags: Health')
    expect(msg).toContain('Rundown here')
    expect(msg).toContain('the transcript is the record of what aired')
    expect(msg.indexOf('Rundown here')).toBeLessThan(msg.indexOf('Transcript:\nT'))
  })
})

describe('summarizeInputsChanged', () => {
  const base = { host: 'A', guest: 'B', notes: null, issues: null }
  it('fires on a new guest, new notes or new issue tags', () => {
    expect(summarizeInputsChanged(base, { ...base, guest: 'C' })).toBe(true)
    expect(summarizeInputsChanged(base, { ...base, notes: 'filled in next morning' })).toBe(true)
    expect(summarizeInputsChanged(base, { ...base, issues: 'Immigration' })).toBe(true)
  })
  it('does not fire when nothing the model sees moved', () => {
    expect(summarizeInputsChanged(base, { ...base })).toBe(false)
  })
  it('does not fire for a pinned guest whose flat value is held', () => {
    // a pinned manual guest keeps its flat value however the human copy moves
    expect(summarizeInputsChanged(base, { ...base, guest: 'B' })).toBe(false)
  })
})
