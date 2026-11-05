import { createBrowserClient } from '@/lib/supabase'
import { filenameFromContentDisposition, readCookieValue } from '@/lib/download'
import { STATION_COOKIE } from '@/lib/station-cookie'

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

/**
 * Download a file from an authenticated API route. Plain `<a href>` links can't
 * carry the Bearer header getStationContext requires (the Supabase session lives
 * in localStorage, not a cookie), so fetch with authedFetch and save the body as
 * a Blob, keeping the server's Content-Disposition filename. Throws with the
 * server's error message on a non-2xx response.
 */
export async function downloadWithAuth(url: string, fallbackFilename: string): Promise<void> {
  const res = await authedFetch(url)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { error?: string }).error || `Download failed (${res.status})`)
  }
  const blob = await res.blob()
  const filename = filenameFromContentDisposition(res.headers.get('Content-Disposition')) ?? fallbackFilename
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer revoke so the browser has started the download.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/** The active station slug from the qir_station cookie (set by the station switcher). */
export function getActiveStationSlug(): string | null {
  if (typeof document === 'undefined') return null
  return readCookieValue(document.cookie, STATION_COOKIE)
}
