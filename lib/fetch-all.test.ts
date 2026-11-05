import { describe, it, expect } from 'vitest'
import { fetchAllRows } from './fetch-all'

// A fake PostgREST that, like the real one, never returns more than 1000 rows.
function fakeTable(total: number, maxRows = 1000) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1, cost: 1 }))
  const calls: Array<[number, number]> = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    return { data: rows.slice(from, Math.min(to + 1, from + maxRows)), error: null }
  }
  return { page, calls }
}

describe('fetchAllRows', () => {
  it('reads past the 1000-row cap (2,512 rows, like KPFK October usage)', async () => {
    const { page, calls } = fakeTable(2512)
    const rows = await fetchAllRows('usage', page)
    expect(rows).toHaveLength(2512)
    expect(rows.reduce((s, r) => s + r.cost, 0)).toBe(2512)
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
  it('stops after one short page and handles empty results', async () => {
    expect(await fetchAllRows('x', fakeTable(0).page)).toEqual([])
    const { page, calls } = fakeTable(1000)
    expect(await fetchAllRows('x', page)).toHaveLength(1000)
    expect(calls).toHaveLength(2) // exact multiple needs one empty probe
  })
  it('throws on a page error instead of returning a partial sum', async () => {
    let n = 0
    const page = async () => (n++ === 0
      ? { data: Array.from({ length: 1000 }, () => ({})), error: null }
      : { data: null, error: { message: 'statement timeout' } })
    await expect(fetchAllRows('usage', page)).rejects.toThrow('Failed to load usage: statement timeout')
  })
})
