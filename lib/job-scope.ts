// Which BullMQ jobs a dashboard caller may see or act on. The queues are shared
// by every station, so a station user is limited to jobs whose data carries
// their station; super-admins see everything (Master Control's job).
export interface ScopedJob {
  data?: { stationId?: unknown } | null
}

export function jobsForCaller<T extends ScopedJob>(
  jobs: T[],
  caller: { stationId: string; isSuperAdmin: boolean }
): T[] {
  if (caller.isSuperAdmin) return jobs
  return jobs.filter((j) => j.data?.stationId === caller.stationId)
}
