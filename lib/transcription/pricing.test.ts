import { describe, it, expect } from 'vitest'
import { isTranscriptionService, transcriptionCostPerSecond } from './pricing'

describe('isTranscriptionService', () => {
  it('buckets every transcription provider, not just Groq', () => {
    for (const s of ['groq', 'deepgram', 'assemblyai']) expect(isTranscriptionService(s)).toBe(true)
  })
  it('keeps OpenAI and unknown/empty services out', () => {
    for (const s of ['openai', 'anthropic', '', null, undefined]) expect(isTranscriptionService(s)).toBe(false)
  })
  it('every bucketed provider has a price (groq per model, others flat)', () => {
    expect(transcriptionCostPerSecond('deepgram')).toBeGreaterThan(0)
    expect(transcriptionCostPerSecond('assemblyai')).toBeGreaterThan(0)
  })
})
