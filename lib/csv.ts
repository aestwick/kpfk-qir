/**
 * CSV encoding shared by every export (QIR report CSV, episode CSV).
 *
 * - Quotes a field containing `,` `"` `\n` or `\r` (a bare `\r` from a pasted
 *   summary used to split a row in Excel).
 * - Neutralises spreadsheet formula injection: a text field starting with
 *   `=` `+` `-` `@` (or tab/CR) gets a leading `'` so Excel/Sheets shows it
 *   as text instead of evaluating it. Plain numbers (e.g. "-5") are left alone.
 * - `toCsv` prepends a UTF-8 BOM so Excel opens Spanish names ("Cabrón",
 *   "Peña") correctly instead of as mojibake.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/
const NUMERIC = /^[+-]?\d+(\.\d+)?$/

export function csvField(value: unknown): string {
  let s = value == null ? '' : String(value)
  if (FORMULA_LEAD.test(s) && !NUMERIC.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvField).join(','), ...rows.map((r) => r.map(csvField).join(','))]
  return '﻿' + lines.join('\r\n')
}
