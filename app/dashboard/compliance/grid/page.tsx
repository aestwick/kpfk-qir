'use client'

// Compliance Grid Report — interactive page shell. Owns the controls bar and
// state (view/metric/duration/comparison/resolved/facets), fetches one or two
// windows from /api/compliance/grid, and delegates rendering to the heatmap and
// matrix components. See ideas/COMPLIANCE_GRID_REPORT_SPEC.md.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { authedFetch } from '@/lib/api-client'
import { Breadcrumbs } from '@/app/components/breadcrumbs'
import { SkeletonBlock } from '@/app/components/skeleton'
import { useToast } from '@/app/components/toast'
import { addDays } from '@/lib/compliance-grid'
import type { GridColumn, GridResponse, GridWindow } from '@/lib/types'
import { HeatmapGrid } from './heatmap'
import { MatrixTable } from './matrix'

type View = 'heatmap' | 'matrix'
type Metric = 'total' | 'avg'

const PRESETS: { label: string; weeks: number }[] = [
  { label: '1w', weeks: 1 },
  { label: '4w', weeks: 4 },
  { label: '12w', weeks: 12 },
  { label: '24w', weeks: 24 },
]

const FLAG_TYPES = ['profanity', 'station_id_missing', 'technical', 'payola_plugola', 'sponsor_id', 'indecency'] as const
const SEVERITIES = ['info', 'warning', 'critical'] as const

const TYPE_LABELS: Record<string, string> = {
  profanity: 'Profanity',
  station_id_missing: 'Station ID',
  technical: 'Technical',
  payola_plugola: 'Payola/Plugola',
  sponsor_id: 'Sponsor ID',
  indecency: 'Indecency',
  summary_discrepancy: 'Summary Discrepancy',
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// A preset window ending today, going back `weeks` (inclusive of today).
function presetWindow(weeks: number): { start: string; end: string } {
  const end = todayIso()
  return { start: addDays(end, -(weeks * 7 - 1)), end }
}

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export default function ComplianceGridPage() {
  const router = useRouter()
  const { toast } = useToast()

  // Controls
  const [view, setView] = useState<View>('heatmap')
  const [metric, setMetric] = useState<Metric>('total')
  const [hourly, setHourly] = useState(true)
  const [presetWeeks, setPresetWeeks] = useState<number | null>(4)
  const [range, setRange] = useState(() => presetWindow(4))
  const [compare, setCompare] = useState(false)
  const [rangeB, setRangeB] = useState(() => {
    const a = presetWindow(4)
    // Default B = the immediately preceding equal-length window.
    return { start: addDays(a.start, -28), end: addDays(a.start, -1) }
  })
  const [includeResolved, setIncludeResolved] = useState(false)
  const [includeDiscrepancies, setIncludeDiscrepancies] = useState(true)
  const [flagTypes, setFlagTypes] = useState<string[]>([])
  const [severities, setSeverities] = useState<string[]>([])

  // Data
  const [data, setData] = useState<GridResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Apply a preset: set window A, and B = the preceding equal-length window.
  function applyPreset(weeks: number) {
    setPresetWeeks(weeks)
    const a = presetWindow(weeks)
    setRange(a)
    setRangeB({ start: addDays(a.start, -(weeks * 7)), end: addDays(a.start, -1) })
  }

  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (compare) {
      p.set('compare', 'true')
      p.set('a_start', range.start)
      p.set('a_end', range.end)
      p.set('b_start', rangeB.start)
      p.set('b_end', rangeB.end)
    } else {
      p.set('start', range.start)
      p.set('end', range.end)
    }
    if (includeResolved) p.set('include_resolved', 'true')
    if (!includeDiscrepancies) p.set('include_discrepancies', 'false')
    if (flagTypes.length) p.set('flag_type', flagTypes.join(','))
    if (severities.length) p.set('severity', severities.join(','))
    return p.toString()
  }, [compare, range, rangeB, includeResolved, includeDiscrepancies, flagTypes, severities])

  const fetchGrid = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authedFetch(`/api/compliance/grid?${queryString}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      setData(await res.json())
    } catch (err) {
      console.error('Failed to load compliance grid:', err)
      setError(err instanceof Error ? err.message : 'Failed to load grid')
      toast('error', 'Failed to load compliance grid')
    } finally {
      setLoading(false)
    }
  }, [queryString, toast])

  useEffect(() => { fetchGrid() }, [fetchGrid])

  // Shared facets every drill-through carries (resolution + single-value type/
  // severity). The list page understands these; multi-select facets are dropped.
  const drillBaseParams = useCallback(() => {
    const p = new URLSearchParams()
    p.set('resolution', includeResolved ? '' : 'unresolved')
    if (flagTypes.length === 1 && flagTypes[0] !== 'summary_discrepancy') p.set('type', flagTypes[0])
    if (severities.length === 1) p.set('severity', severities[0])
    return p
  }, [includeResolved, flagTypes, severities])

  // Drill-through from the matrix: filter the flag list to a single show.
  function drillToShow(showKey: string) {
    const p = drillBaseParams()
    const win = data?.window ?? data?.a
    const showName = win?.matrix.find((r) => r.show_key === showKey)?.show_name
    if (showName) p.set('show', showName)
    router.push(`/dashboard/compliance?${p.toString()}`)
  }

  // Drill-through from a heatmap cell: a day-of-week + time slot within window A.
  // The list page expands dow→dates inside [win_start, win_end] server-side.
  function drillToCell(day: number, airStarts: string[]) {
    const win = data?.window ?? data?.a
    if (!win) return
    const p = drillBaseParams()
    p.set('dow', String(day))
    p.set('air_start', airStarts.join(','))
    p.set('win_start', win.start)
    p.set('win_end', win.end)
    router.push(`/dashboard/compliance?${p.toString()}`)
  }

  const winA: GridWindow | undefined = data?.window ?? data?.a
  const winB: GridWindow | undefined = data?.b

  return (
    <div className="space-y-6">
      <Breadcrumbs />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-warm-100">Compliance Grid</h1>
          <p className="text-sm text-gray-500 dark:text-warm-400 mt-0.5">
            When in the week are we getting flagged, and which shows repeat?
          </p>
        </div>
        <Link
          href="/dashboard/compliance"
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border rounded-lg hover:bg-gray-50 dark:bg-surface-raised dark:text-warm-200 dark:border-warm-600 dark:hover:bg-warm-700/50"
        >
          ← Flag list
        </Link>
      </div>

      <Controls
        view={view} setView={setView}
        metric={metric} setMetric={setMetric}
        hourly={hourly} setHourly={setHourly}
        presetWeeks={presetWeeks} applyPreset={applyPreset}
        range={range} setRange={(r) => { setRange(r); setPresetWeeks(null) }}
        compare={compare} setCompare={setCompare}
        rangeB={rangeB} setRangeB={setRangeB}
        includeResolved={includeResolved} setIncludeResolved={setIncludeResolved}
        includeDiscrepancies={includeDiscrepancies} setIncludeDiscrepancies={setIncludeDiscrepancies}
        flagTypes={flagTypes} setFlagTypes={setFlagTypes}
        severities={severities} setSeverities={setSeverities}
      />

      {loading ? (
        <SkeletonBlock />
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-sm text-red-700 dark:bg-red-900/20 dark:border-red-800/40 dark:text-red-300">
          {error}
        </div>
      ) : winA ? (
        <>
          <SummaryStrip winA={winA} winB={winB} compare={compare} />
          <div className="bg-white rounded-xl shadow-sm border p-4 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
            {view === 'heatmap' ? (
              <HeatmapView winA={winA} winB={winB} compare={compare} hourly={hourly} metric={metric} onCellClick={drillToCell} />
            ) : (
              <MatrixView winA={winA} winB={winB} compare={compare} metric={metric} onShowClick={drillToShow} />
            )}
          </div>
          <Legend compare={compare} />
        </>
      ) : null}
    </div>
  )
}

// --- Heatmap / matrix view wrappers -------------------------------------------

function HeatmapView({ winA, winB, compare, hourly, metric, onCellClick }: {
  winA: GridWindow; winB?: GridWindow; compare: boolean; hourly: boolean; metric: Metric
  onCellClick: (day: number, airStarts: string[]) => void
}) {
  if (compare && winB) {
    // Drill-through is disabled in compare mode: a cell spans two windows, so a
    // single day/time → flag-list query would be ambiguous.
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <WindowPanel label={`A · ${winA.start} → ${winA.end}`}>
            <HeatmapGrid grid={winA.heatmap} hourly={hourly} weeks={winA.weeks} metric={metric} />
          </WindowPanel>
          <WindowPanel label={`B · ${winB.start} → ${winB.end}`}>
            <HeatmapGrid grid={winB.heatmap} hourly={hourly} weeks={winB.weeks} metric={metric} />
          </WindowPanel>
        </div>
        <WindowPanel label="Δ  B − A (green = fewer, red = more)">
          <HeatmapGrid grid={winA.heatmap} delta={{ a: winA.heatmap, b: winB.heatmap }} hourly={hourly} weeks={1} metric="total" />
        </WindowPanel>
      </div>
    )
  }
  return <HeatmapGrid grid={winA.heatmap} hourly={hourly} weeks={winA.weeks} metric={metric} onCellClick={onCellClick} />
}

function MatrixView({ winA, winB, compare, metric, onShowClick }: {
  winA: GridWindow; winB?: GridWindow; compare: boolean; metric: Metric; onShowClick: (k: string) => void
}) {
  if (compare && winB) {
    // Compare matrices need a shared column axis; use A's columns when aligned,
    // otherwise show side-by-side single matrices.
    const sameAxis = winA.columns.length === winB.columns.length
    if (sameAxis) {
      return (
        <WindowPanel label="Δ  B − A by show">
          <MatrixTable columns={winA.columns} rows={winA.matrix} metric={metric} compareRows={{ a: winA.matrix, b: winB.matrix }} onCellClick={(k) => onShowClick(k)} />
        </WindowPanel>
      )
    }
    return (
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <WindowPanel label={`A · ${winA.start} → ${winA.end}`}>
          <MatrixTable columns={winA.columns} rows={winA.matrix} metric={metric} onCellClick={(k) => onShowClick(k)} />
        </WindowPanel>
        <WindowPanel label={`B · ${winB.start} → ${winB.end}`}>
          <MatrixTable columns={winB.columns} rows={winB.matrix} metric={metric} onCellClick={(k) => onShowClick(k)} />
        </WindowPanel>
      </div>
    )
  }
  return <MatrixTable columns={winA.columns} rows={winA.matrix} metric={metric} onCellClick={(k) => onShowClick(k)} />
}

function WindowPanel({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 dark:text-warm-400 uppercase tracking-wide mb-2">{label}</p>
      {children}
    </div>
  )
}

// --- Summary + legend ---------------------------------------------------------

function SummaryStrip({ winA, winB, compare }: { winA: GridWindow; winB?: GridWindow; compare: boolean }) {
  const cards: { label: string; value: string | number; sub?: string }[] = [
    { label: compare ? 'Offenses (A)' : 'Total offenses', value: winA.totalOffenses, sub: `${winA.airingsCounted} airings` },
    { label: compare ? 'Offenses (B)' : 'Avg / week', value: compare ? (winB?.totalOffenses ?? 0) : (winA.totalOffenses / winA.weeks).toFixed(1) },
    { label: compare ? 'Δ  B − A' : 'Window', value: compare ? signed((winB?.totalOffenses ?? 0) - winA.totalOffenses) : `${winA.weeks}w`, sub: compare ? undefined : `${winA.start} → ${winA.end}` },
    { label: 'Unplaced', value: winA.unplacedOffenses, sub: 'no air time' },
  ]
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-white rounded-xl shadow-sm border p-3 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide dark:text-warm-500">{c.label}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1 dark:text-warm-100">{c.value}</p>
          {c.sub && <p className="text-xs text-gray-500 dark:text-warm-400">{c.sub}</p>}
        </div>
      ))}
    </div>
  )
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function Legend({ compare }: { compare: boolean }) {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-warm-400 flex-wrap">
      <span className="font-medium">Intensity:</span>
      {compare ? (
        <>
          <Swatch cls="bg-green-600" label="fewer (B<A)" />
          <Swatch cls="bg-warm-100 dark:bg-warm-800" label="no change" />
          <Swatch cls="bg-kpfk-red" label="more (B>A)" />
        </>
      ) : (
        <>
          <Swatch cls="bg-warm-100 dark:bg-warm-800" label="0" />
          <Swatch cls="bg-kpfk-red/20" label="1" />
          <Swatch cls="bg-kpfk-red/40" label="2–3" />
          <Swatch cls="bg-kpfk-red/65" label="4–6" />
          <Swatch cls="bg-kpfk-red" label="7+" />
        </>
      )}
    </div>
  )
}

function Swatch({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`inline-block w-4 h-4 rounded ${cls}`} />
      <span>{label}</span>
    </span>
  )
}

// --- Controls bar -------------------------------------------------------------

interface ControlsProps {
  view: View; setView: (v: View) => void
  metric: Metric; setMetric: (m: Metric) => void
  hourly: boolean; setHourly: (h: boolean) => void
  presetWeeks: number | null; applyPreset: (w: number) => void
  range: { start: string; end: string }; setRange: (r: { start: string; end: string }) => void
  compare: boolean; setCompare: (c: boolean) => void
  rangeB: { start: string; end: string }; setRangeB: (r: { start: string; end: string }) => void
  includeResolved: boolean; setIncludeResolved: (b: boolean) => void
  includeDiscrepancies: boolean; setIncludeDiscrepancies: (b: boolean) => void
  flagTypes: string[]; setFlagTypes: (f: string[]) => void
  severities: string[]; setSeverities: (s: string[]) => void
}

function Controls(p: ControlsProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm border p-4 dark:bg-surface-raised dark:shadow-card-dark dark:border-warm-700 space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented label="View" value={p.view} options={[['heatmap', 'Heatmap'], ['matrix', 'Matrix']]} onChange={(v) => p.setView(v as View)} />
        <Segmented label="Metric" value={p.metric} options={[['total', 'Total'], ['avg', 'Avg/wk']]} onChange={(v) => p.setMetric(v as Metric)} />
        {p.view === 'heatmap' && (
          <Segmented label="Rows" value={p.hourly ? 'hourly' : 'half'} options={[['hourly', 'Hourly'], ['half', '½ hour']]} onChange={(v) => p.setHourly(v === 'hourly')} />
        )}
        <div>
          <p className="text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">Duration</p>
          <div className="flex gap-1">
            {PRESETS.map((preset) => (
              <button
                key={preset.weeks}
                onClick={() => p.applyPreset(preset.weeks)}
                className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${
                  p.presetWeeks === preset.weeks
                    ? 'bg-kpfk-red text-white border-kpfk-red'
                    : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50 dark:bg-warm-800 dark:text-warm-300 dark:border-warm-600 dark:hover:bg-warm-700/50'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>
        <ToggleChip label="Compare A/B" on={p.compare} onClick={() => p.setCompare(!p.compare)} />
        <ToggleChip label="Include resolved" on={p.includeResolved} onClick={() => p.setIncludeResolved(!p.includeResolved)} />
        <ToggleChip label="Discrepancies" on={p.includeDiscrepancies} onClick={() => p.setIncludeDiscrepancies(!p.includeDiscrepancies)} />
      </div>

      {/* Date ranges */}
      <div className="flex flex-wrap items-end gap-4">
        <DateRange label={p.compare ? 'Window A' : 'Window'} value={p.range} onChange={p.setRange} />
        {p.compare && <DateRange label="Window B" value={p.rangeB} onChange={p.setRangeB} />}
      </div>

      {/* Facets */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-2">
        <FacetGroup label="Flag type" all={[...FLAG_TYPES]} selected={p.flagTypes} onToggle={(v) => p.setFlagTypes(toggleIn(p.flagTypes, v))} />
        <FacetGroup label="Severity" all={[...SEVERITIES]} selected={p.severities} onToggle={(v) => p.setSeverities(toggleIn(p.severities, v))} />
      </div>
    </div>
  )
}

function Segmented({ label, value, options, onChange }: {
  label: string; value: string; options: [string, string][]; onChange: (v: string) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">{label}</p>
      <div className="inline-flex rounded-lg border border-gray-200 dark:border-warm-600 overflow-hidden">
        {options.map(([val, lbl]) => (
          <button
            key={val}
            onClick={() => onChange(val)}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              value === val
                ? 'bg-kpfk-red text-white'
                : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-warm-800 dark:text-warm-300 dark:hover:bg-warm-700/50'
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>
    </div>
  )
}

function ToggleChip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`mt-4 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
        on
          ? 'bg-kpfk-red/10 text-kpfk-red-dark border-kpfk-red/40 dark:text-kpfk-red-light'
          : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50 dark:bg-warm-800 dark:text-warm-400 dark:border-warm-600 dark:hover:bg-warm-700/50'
      }`}
    >
      {on ? '✓ ' : ''}{label}
    </button>
  )
}

function DateRange({ label, value, onChange }: {
  label: string; value: { start: string; end: string }; onChange: (r: { start: string; end: string }) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={value.start}
          max={value.end}
          onChange={(e) => onChange({ ...value, start: e.target.value })}
          className="border rounded-lg px-2 py-1 text-xs dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
        />
        <span className="text-gray-400 text-xs">→</span>
        <input
          type="date"
          value={value.end}
          min={value.start}
          onChange={(e) => onChange({ ...value, end: e.target.value })}
          className="border rounded-lg px-2 py-1 text-xs dark:bg-warm-800 dark:border-warm-600 dark:text-warm-100"
        />
      </div>
    </div>
  )
}

function FacetGroup({ label, all, selected, onToggle }: {
  label: string; all: string[]; selected: string[]; onToggle: (v: string) => void
}) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-warm-400 mb-1">{label} <span className="text-gray-400 dark:text-warm-500">{selected.length ? `(${selected.length})` : '(all)'}</span></p>
      <div className="flex flex-wrap gap-1">
        {all.map((v) => (
          <button
            key={v}
            onClick={() => onToggle(v)}
            className={`px-2 py-0.5 text-2xs font-medium rounded-full border transition-colors ${
              selected.includes(v)
                ? 'bg-kpfk-red text-white border-kpfk-red'
                : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50 dark:bg-warm-800 dark:text-warm-400 dark:border-warm-600 dark:hover:bg-warm-700/50'
            }`}
          >
            {TYPE_LABELS[v] ?? v}
          </button>
        ))}
      </div>
    </div>
  )
}
