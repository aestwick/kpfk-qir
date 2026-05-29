import { createBrowserClient } from '@/lib/supabase'

/**
 * fetch wrapper for dashboard (client) pages that attaches the caller's Supabase
 * access token as a Bearer header so API routes can resolve station context via
 * getStationContext. The active-station cookie (qir_station) rides along
 * automatically as a same-origin cookie, so it does not need to be set here.
 */
export async function authedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const supabase = createBrowserClient()
  const { data: { session } } = await supabase.auth.getSession()
  const headers = new Headers(init.headers)
  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`)
  }
  return fetch(input, { ...init, headers })
}
