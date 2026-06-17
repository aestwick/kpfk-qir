import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { generateApiKey, hashApiKey, requireScope } from './api-auth'

describe('api-auth key generation', () => {
  it('hashApiKey is sha256 hex of the raw key', () => {
    const expected = createHash('sha256').update('hello').digest('hex')
    expect(hashApiKey('hello')).toBe(expected)
  })

  it('generateApiKey returns a prefixed secret, its matching hash, and a prefix', () => {
    const { raw, hash, prefix } = generateApiKey()
    expect(raw.startsWith('qir_live_')).toBe(true)
    expect(hash).toBe(hashApiKey(raw))
    expect(prefix).toBe(raw.slice(0, 12))
    expect(prefix).not.toBe(raw) // prefix is non-secret, not the whole key
  })

  it('generates unique keys', () => {
    const a = generateApiKey()
    const b = generateApiKey()
    expect(a.raw).not.toBe(b.raw)
    expect(a.hash).not.toBe(b.hash)
  })
})

describe('requireScope', () => {
  const ctx = { keyId: 1, stationId: 's1', scopes: ['qir', 'episodes'], rateLimitPerMin: 60 }

  it('passes (null) when the scope is present', () => {
    expect(requireScope(ctx, 'qir')).toBeNull()
  })

  it('returns a 403 error when the scope is absent', () => {
    const err = requireScope(ctx, 'transcripts')
    expect(err).not.toBeNull()
    expect(err!.status).toBe(403)
    expect(err!.error).toContain('transcripts')
  })
})
