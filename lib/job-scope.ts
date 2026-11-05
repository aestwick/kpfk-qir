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

/**
 * Page through a shared queue (fetchPage(start, end) is BullMQ's inclusive
 * range, e.g. queue.getFailed) collecting the caller's jobs until `limit` are
 * found or the queue runs out. Filtering one fixed page instead let another
 * station's backlog hide the caller's jobs entirely (retry/clear made no
 * progress). `maxScan` bounds the work on a very large queue.
 */
export async function collectJobsForCaller<T extends ScopedJob>(
  fetchPage: (start: number, end: number) => Promise<T[]>,
  caller: { stationId: string; isSuperAdmin: boolean },
  limit: number,
  { pageSize = 200, maxScan = 10_000 }: { pageSize?: number; maxScan?: number } = {}
): Promise<T[]> {
  const out: T[] = []
  for (let start = 0; start < maxScan && out.length < limit; start += pageSize) {
    const page = await fetchPage(start, start + pageSize - 1)
    out.push(...jobsForCaller(page, caller))
    if (page.length < pageSize) break
  }
  return out.slice(0, limit)
}
