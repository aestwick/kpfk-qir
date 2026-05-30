'use client'

// Show × period offense matrix: rows are shows (worst first), columns are weeks
// or months of the window. The month-to-month / quarter-to-quarter trend view.
// In compare mode each cell shows the B−A delta with a diverging scale.

import { useMemo } from 'react'
import { deltaClass, intensityClass } from '@/lib/compliance-grid'
import type { GridColumn, MatrixRow } from '@/lib/types'

interface MatrixTableProps {
  columns: GridColumn[]
  rows: MatrixRow[]
  metric: 'total' | 'avg'
  // When provided, render B−A per (show, column) and order by |total delta|.
  compareRows?: { a: MatrixRow[]; b: MatrixRow[] }
  onCellClick?: (showKey: string, column: GridColumn) => void
}

// Merge A and B matrices into delta rows keyed by show, aligned to columns.
function buildDeltaRows(a: MatrixRow[], b: MatrixRow[], colCount: number): MatrixRow[] {
  const byShow = new Map<string, MatrixRow>()
  const ensure = (r: MatrixRow): MatrixRow => {
    let row = byShow.get(r.show_key)
    if (!row) {
      row = { show_key: r.show_key, show_name: r.show_name, total: 0, cells: new Array(colCount).fill(0) }
      byShow.set(r.show_key, row)
    }
    return row
  }
  for (const r of a) {
    const row = ensure(r)
    r.cells.forEach((v, i) => { row.cells[i] -= v })
    row.total -= r.total
  }
  for (const r of b) {
    const row = ensure(r)
    r.cells.forEach((v, i) => { row.cells[i] += v })
    row.total += r.total
  }
  return Array.from(byShow.values()).sort((x, y) => Math.abs(y.total) - Math.abs(x.total))
}

export function MatrixTable({ columns, rows, metric, compareRows, onCellClick }: MatrixTableProps) {
  const isDelta = !!compareRows

  const displayRows = useMemo<MatrixRow[]>(() => {
    if (compareRows) return buildDeltaRows(compareRows.a, compareRows.b, columns.length)
    return rows
  }, [rows, compareRows, columns.length])

  function cellValue(row: MatrixRow, colIndex: number): number {
    const raw = row.cells[colIndex] ?? 0
    if (metric === 'avg' && !isDelta) {
      const weeks = Math.max(1, columns[colIndex]?.weeks ?? 1)
      return raw / weeks
    }
    return raw
  }

  function format(value: number): string {
    if (value === 0) return ''
    if (metric === 'avg' && !isDelta) return value.toFixed(value < 1 ? 1 : 0)
    if (isDelta && value > 0) return `+${value}`
    return String(value)
  }

  if (displayRows.length === 0) {
    return (
      <div className="text-center text-gray-400 dark:text-warm-500 py-12 text-sm">
        No offenses in this window.
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white dark:bg-surface-raised text-left px-3 py-2 text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase border-b dark:border-warm-700">
              Show
            </th>
            {columns.map((c) => (
              <th
                key={c.key}
                className="px-2 py-2 text-center text-2xs font-semibold text-gray-500 dark:text-warm-400 border-b dark:border-warm-700 whitespace-nowrap"
              >
                {c.label}
              </th>
            ))}
            <th className="px-3 py-2 text-center text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase border-b dark:border-warm-700">
              Total
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-warm-800">
          {displayRows.map((row) => (
            <tr key={row.show_key}>
              <td className="sticky left-0 z-10 bg-white dark:bg-surface-raised px-3 py-2 font-medium text-gray-900 dark:text-warm-100 max-w-[220px] truncate">
                {row.show_name}
              </td>
              {columns.map((c, i) => {
                const value = cellValue(row, i)
                const rounded = Math.round(value * 10) / 10
                const cls = isDelta ? deltaClass(rounded) : intensityClass(rounded)
                return (
                  <td key={c.key} className="p-0.5">
                    <button
                      type="button"
                      disabled={!onCellClick}
                      onClick={onCellClick ? () => onCellClick(row.show_key, c) : undefined}
                      className={`w-full h-8 text-center text-2xs font-medium rounded transition-colors ${cls} ${onCellClick ? 'hover:ring-1 hover:ring-inset hover:ring-kpfk-red/50 cursor-pointer' : 'cursor-default'}`}
                      title={`${row.show_name} · ${c.label}: ${rounded}`}
                    >
                      {format(rounded)}
                    </button>
                  </td>
                )
              })}
              <td className={`px-3 py-2 text-center font-bold ${row.total < 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-900 dark:text-warm-100'}`}>
                {isDelta && row.total > 0 ? `+${row.total}` : row.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
