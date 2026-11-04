import { describe, it, expect } from 'vitest'
import { isSpendLimitError } from './retry-policy'

describe('isSpendLimitError', () => {
  it('recognises existing spend blocks', () => {
    expect(isSpendLimitError('429 spend_limit_reached')).toBe(true)
    expect(isSpendLimitError('Groq blocked API access because the org exceeded…')).toBe(true)
  })
  it('recognises provider billing lapses (no strike against the episode)', () => {
    expect(isSpendLimitError('Deepgram 402 {"err_code":"ASR_PAYMENT_REQUIRED","err_msg":"Project does not have enough credits"}')).toBe(true)
    expect(isSpendLimitError('402 Payment Required')).toBe(true)
  })
  it('does not swallow ordinary episode failures', () => {
    expect(isSpendLimitError('OpenAI returned incomplete summary')).toBe(false)
    expect(isSpendLimitError('ffmpeg exited with code 1')).toBe(false)
    expect(isSpendLimitError(null)).toBe(false)
  })
})
