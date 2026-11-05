import { describe, it, expect } from 'vitest'
import { jobsForCaller } from './job-scope'

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
