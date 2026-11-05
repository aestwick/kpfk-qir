/**
 * Pull the filename out of a Content-Disposition header so a blob download
 * started from fetch() keeps the name the server chose. Handles the RFC 6266
 * forms we can meet: `filename*=UTF-8''<pct-encoded>` (preferred when present),
 * `filename="quoted"` and `filename=bare`. Returns `fallback` when the header is
 * missing or carries no usable name. Path separators are stripped so a header
 * can never suggest a directory.
 */
export function filenameFromContentDisposition(header: string | null | undefined, fallback: string): string {
  if (!header) return fallback
  let name: string | null = null

  const star = header.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i)
  if (star) {
    try {
      name = decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''))
    } catch {
      name = null
    }
  }
  if (!name) {
    const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i)
    if (quoted) name = quoted[1].replace(/\\(.)/g, '$1')
  }
  if (!name) {
    const bare = header.match(/filename\s*=\s*([^;"\s]+)/i)
    if (bare) name = bare[1]
  }

  const cleaned = name?.replace(/[\\/]/g, '_').trim()
  return cleaned ? cleaned : fallback
}
