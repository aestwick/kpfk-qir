// Pure helpers for dashboard downloads and station-scoped public links.
// Kept free of browser/Next imports so they're unit-testable under node.

/**
 * Extract the filename from a Content-Disposition header. Prefers the RFC 5987
 * `filename*=UTF-8''…` form, then a quoted or bare `filename=`. Returns null
 * when absent so the caller can supply a fallback.
 */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i)
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {
      // fall through to the plain form
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:\\.|[^"\\])*)"/i)
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1')
  const bare = header.match(/filename\s*=\s*([^;]+)/i)
  if (bare) return bare[1].trim()
  return null
}

/**
 * Path of a station's public finalized QIR. Always station-qualified: the
 * legacy `/{year}/q{quarter}` form 308-redirects to KPFK (next.config.js), so
 * building it for any other station would show KPFK's report.
 */
export function publicQirPath(stationSlug: string, year: number, quarter: number): string {
  return `/${encodeURIComponent(stationSlug)}/${year}/q${quarter}`
}
