import { describe, it, expect, vi, afterEach } from 'vitest'
import { withDeadline, DeadlineExceededError } from './deadline'

afterEach(() => vi.useRealTimers())

describe('withDeadline', () => {
  it('resolves with the work result when it finishes in time', async () => {
    await expect(withDeadline(Promise.resolve(42), 1000, 'x')).resolves.toBe(42)
  })

  it('passes through the work error unchanged', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom')
  })

  it('rejects with DeadlineExceededError when the work never settles', async () => {
    vi.useFakeTimers()
    const p = withDeadline(new Promise(() => {}), 45 * 60_000, 'episode 10986')
    vi.advanceTimersByTime(45 * 60_000)
    await expect(p).rejects.toBeInstanceOf(DeadlineExceededError)
    await expect(p).rejects.toThrow('episode 10986 timed out after 45 min')
  })

  it('swallows a late rejection from abandoned work', async () => {
    vi.useFakeTimers()
    let rejectLate!: (e: Error) => void
    const work = new Promise((_, r) => { rejectLate = r })
    const p = withDeadline(work, 100, 'x')
    vi.advanceTimersByTime(100)
    await expect(p).rejects.toBeInstanceOf(DeadlineExceededError)
    rejectLate(new Error('late')) // must not become an unhandled rejection
    await Promise.resolve()
  })
})
