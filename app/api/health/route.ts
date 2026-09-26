import { NextResponse } from 'next/server'

// Without this, Next statically renders the handler at build time and serves
// the frozen body forever (observed live: x-nextjs-cache: HIT with a
// build-time timestamp) — a health check that can't tell anyone anything.
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ status: 'ok', timestamp: new Date().toISOString() })
}
