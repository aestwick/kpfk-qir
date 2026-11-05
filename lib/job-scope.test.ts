import { describe, it, expect } from 'vitest'
import { jobsForCaller, collectJobsForCaller } from './job-scope'

const jobs = [
  { id: 1, data: { stationId: 'kpfk' } },
  { id: 2, data: { stationId: 'wpfw' } },
  { id: 3, data: {} },
  { id: 4, data: null },
]

describe('jobsForCaller', () => {
  it('limits a station user to their own station’s jobs', () => {
    expect(jobsForCaller(jobs, { stationId: 'kpfk', isSuperAdmin: false }).map((j) => j.id)).toEqual([1])
  })
  it('lets a super-admin see every job', () => {
    expect(jobsForCaller(jobs, { stationId: 'kpfk', isSuperAdmin: true })).toHaveLength(4)
  })
})

describe('collectJobsForCaller', () => {
  // 250 WPFW jobs ahead of 3 KPFK jobs in one shared failed queue.
  const queue = [
    ...Array.from({ length: 250 }, (_, i) => ({ id: i, data: { stationId: 'wpfw' } })),
    ...[1000, 1001, 1002].map((id) => ({ id, data: { stationId: 'kpfk' } })),
  ]
  const fetchPage = async (s: number, e: number) => queue.slice(s, e + 1)

  it('finds the caller’s jobs behind another station’s backlog', async () => {
    const mine = await collectJobsForCaller(fetchPage, { stationId: 'kpfk', isSuperAdmin: false }, 100, { pageSize: 100 })
    expect(mine.map((j) => j.id)).toEqual([1000, 1001, 1002])
  })
  it('stops at the limit', async () => {
    const all = await collectJobsForCaller(fetchPage, { stationId: 'x', isSuperAdmin: true }, 120, { pageSize: 100 })
    expect(all).toHaveLength(120)
  })
  it('respects maxScan on a huge queue', async () => {
    const none = await collectJobsForCaller(fetchPage, { stationId: 'kpfk', isSuperAdmin: false }, 10, { pageSize: 100, maxScan: 200 })
    expect(none).toEqual([])
  })
})
