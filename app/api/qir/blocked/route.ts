import { NextRequest, NextResponse } from 'next/server'
import { getStationContext, stationErrorResponse } from '@/lib/auth'
import { getQuarterDateRange } from '@/lib/qir-format'
import { isComplianceBlocking } from '@/lib/settings'
import { getQuarterBlockingReport } from '@/lib/compliance-blocking'

export const dynamic = 'force-dynamic'

/**
 * GET /api/qir/blocked?year=2026&quarter=4
 * Live view of the episodes compliance blocking holds out of this quarter's
 * draft — same candidate query + flag predicate as workers/generate-qir.ts
 * (lib/compliance-blocking.ts). `enabled` says whether the gate is on; when it
 * is off, `episodes` is what it *would* hold out.
 */
export async function GET(request: NextRequest) {
  try {
    const result = await getStationContext(request)
    if (result.error) return stationErrorResponse(result.error)
    const { supabase, stationId } = result.context

    const { searchParams } = new URL(request.url)
    const year = parseInt(searchParams.get('year') ?? '')
    const quarter = parseInt(searchParams.get('quarter') ?? '')
    if (!year || !quarter || quarter < 1 || quarter > 4) {
      return NextResponse.json({ error: 'Valid year and quarter (1-4) required' }, { status: 400 })
    }

    const { start, end } = getQuarterDateRange(year, quarter)
    const report = await getQuarterBlockingReport(supabase, stationId, start, end, await isComplianceBlocking())
    return NextResponse.json(report)
  } catch (err) {
    console.error('GET /api/qir/blocked failed:', err)
    return NextResponse.json({ error: 'Failed to compute compliance blocking' }, { status: 500 })
  }
}
