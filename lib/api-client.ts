import { createBrowserClient } from '@/lib/supabase'
import { filenameFromContentDisposition } from '@/lib/content-disposition'

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
 * Download an authenticated API response as a file. A plain <a href> to an API
 * route sends no Bearer token (→ 401 "Missing bearer token"), so fetch with
 * authedFetch, turn the body into a Blob and click a temporary object-URL link.
 * The filename comes from the server's Content-Disposition; `fallbackName` is
 * used only if the server sent none. Throws with the server's error message on
 * a non-2xx response so the caller can show it.
 */
export async function downloadAuthed(url: string, fallbackName: string): Promise<void> {
  const res = await authedFetch(url)
  if (!res.ok) {
    const data = await res.json().catch(() => ({} as { error?: string }))
    throw new Error(data.error || `Download failed (${res.status})`)
  }
  const blob = await res.blob()
  const filename = filenameFromContentDisposition(res.headers.get('Content-Disposition'), fallbackName)
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so the click has started the download first.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}
