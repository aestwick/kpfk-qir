import { describe, it, expect } from 'vitest'
import { DEFAULT_GROQ_MODEL, resolveGroqModel, groqCostPerSecond } from './groq-models'
import { transcriptionCostPerSecond } from './transcription/pricing'

describe('resolveGroqModel', () => {
  it('defaults to turbo when unset or unknown', () => {
    expect(DEFAULT_GROQ_MODEL).toBe('whisper-large-v3-turbo')
    expect(resolveGroqModel(undefined)).toBe('whisper-large-v3-turbo')
    expect(resolveGroqModel('whisper-tiny')).toBe('whisper-large-v3-turbo')
  })
  it('keeps a supported choice', () => {
    expect(resolveGroqModel('whisper-large-v3')).toBe('whisper-large-v3')
  })
})

describe('transcription pricing', () => {
  it('prices Groq per model, per hour of audio', () => {
    expect(groqCostPerSecond('whisper-large-v3-turbo') * 3600).toBeCloseTo(0.04)
    expect(groqCostPerSecond('whisper-large-v3') * 3600).toBeCloseTo(0.111)
    expect(transcriptionCostPerSecond('groq', 'whisper-large-v3') * 3600).toBeCloseTo(0.111)
  })
  it('prices unknown providers at zero', () => {
    expect(transcriptionCostPerSecond('nope')).toBe(0)
  })
})
