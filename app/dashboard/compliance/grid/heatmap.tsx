'use client'

// Read-only 7-day × time-of-day offense density grid. Borrows the CMS schedule
// geometry (Sunday-first columns, sticky day header + time gutter) but renders
// offense intensity, not editable slots. Hourly (24 rows) by default; toggleable
// to the full 48-row half-hour view. Delta mode swaps to a diverging scale.

import { useMemo } from 'react'
import {
  DAY_NAMES_SHORT,
  collapseToHourly,
  computeDelta,
  deltaClass,
  formatTime12,
  intensityClass,
  rowToTime,
} from '@/lib/compliance-grid'
import type { Heatmap } from '@/lib/types'

interface HeatmapGridProps {
  // When `delta` is provided we render B−A; otherwise `grid` (a single window).
  grid: Heatmap
  delta?: { a: Heatmap; b: Heatmap }
  hourly: boolean
  weeks: number
  metric: 'total' | 'avg'
  // Drill-through: the clicked day (0=Sun) and the air_start slot(s) it covers
  // ('HH:MM:SS' — one for a half-hour row, two for an hourly row).
  onCellClick?: (day: number, airStarts: string[]) => void
}

// The air_start slot strings a display row maps to (1 half-hour, 2 hourly).
function slotsForRow(row: number, hourly: boolean): string[] {
  const rows = hourly ? [row * 2, row * 2 + 1] : [row]
  return rows.map((r) => `${rowToTime(r)}:00`)
}

function rowLabel(displayRow: number, hourly: boolean): string {
  // In hourly mode each display row is one hour (= half-hour row 2*display).
  return formatTime12(hourly ? displayRow * 2 : displayRow)
}

export function HeatmapGrid({ grid, delta, hourly, weeks, metric, onCellClick }: HeatmapGridProps) {
  const isDelta = !!delta

  // Resolve the grid we actually render (single or delta), at the chosen
  // granularity. Half-hour data is the source of truth; hourly collapses it.
  const display = useMemo<Heatmap>(() => {
    const base: Heatmap = isDelta ? computeDelta(delta!.a, delta!.b) : grid
    return hourly ? collapseToHourly(base) : base
  }, [grid, delta, isDelta, hourly])

  const rowCount = display[0]?.length ?? 0
  const denom = metric === 'avg' ? Math.max(1, weeks) : 1

  function cellValue(day: number, row: number): number {
    const raw = display[day]?.[row] ?? 0
    if (metric === 'avg' && !isDelta) return raw / denom
    return raw
  }

  function format(value: number): string {
    if (value === 0) return ''
    if (metric === 'avg' && !isDelta) return value.toFixed(value < 1 ? 1 : 0)
    if (isDelta && value > 0) return `+${value}`
    return String(value)
  }

  return (
    <div className="overflow-x-auto">
      <div className="inline-grid" style={{ gridTemplateColumns: `4rem repeat(7, minmax(3rem, 1fr))` }}>
        {/* Header row: corner + day names */}
        <div className="sticky top-0 z-10 bg-white dark:bg-surface-raised" />
        {DAY_NAMES_SHORT.map((d) => (
          <div
            key={d}
            className="sticky top-0 z-10 bg-white dark:bg-surface-raised text-center text-xs font-semibold text-gray-500 dark:text-warm-400 py-1.5 border-b dark:border-warm-700"
          >
            {d}
          </div>
        ))}

        {/* Time rows */}
        {Array.from({ length: rowCount }, (_, row) => (
          <RowCells
            key={row}
            row={row}
            label={rowLabel(row, hourly)}
            days={DAY_NAMES_SHORT.length}
            cellValue={cellValue}
            format={format}
            isDelta={isDelta}
            hourly={hourly}
            onCellClick={onCellClick}
          />
        ))}
      </div>
    </div>
  )
}

interface RowCellsProps {
  row: number
  label: string
  days: number
  cellValue: (day: number, row: number) => number
  format: (value: number) => string
  isDelta: boolean
  hourly: boolean
  onCellClick?: (day: number, airStarts: string[]) => void
}

function RowCells({ row, label, days, cellValue, format, isDelta, hourly, onCellClick }: RowCellsProps) {
  // The air_start slot(s) this row covers — same for every day in the row.
  const slots = slotsForRow(row, hourly)
  return (
    <>
      <div className="text-right pr-2 text-2xs text-gray-400 dark:text-warm-500 border-r dark:border-warm-700 flex items-center justify-end h-7">
        {label}
      </div>
      {Array.from({ length: days }, (_, day) => {
        const value = cellValue(day, row)
        const rounded = Math.round(value * 10) / 10
        const cls = isDelta ? deltaClass(rounded) : intensityClass(rounded)
        return (
          <button
            key={day}
            type="button"
            disabled={!onCellClick}
            onClick={onCellClick ? () => onCellClick(day, slots) : undefined}
            className={`h-7 text-center text-2xs font-medium border-b border-r border-warm-100 dark:border-warm-800 transition-colors ${cls} ${onCellClick ? 'hover:ring-1 hover:ring-inset hover:ring-kpfk-red/50 cursor-pointer' : 'cursor-default'}`}
            title={value ? `${rounded} offense${rounded === 1 ? '' : 's'}` : 'No offenses'}
          >
            {format(rounded)}
          </button>
        )
      })}
    </>
  )
}
