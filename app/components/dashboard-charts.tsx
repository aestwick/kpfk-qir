'use client'

interface DailyPoint { date: string; groq: number; openai: number; total: number }

function fmt$(n: number) { return '$' + n.toFixed(4) }

/* ─── mini bar chart (pure CSS) ─── */
export function MiniBar({ data, maxHeight = 48 }: { data: DailyPoint[]; maxHeight?: number }) {
  if (data.length === 0) return <div className="text-xs text-warm-400">No cost data yet</div>
  const max = Math.max(...data.map(d => d.total), 0.001)
  return (
    <div className="flex items-end gap-px" style={{ height: maxHeight }}>
      {data.map((d) => {
        const groqH = (d.groq / max) * maxHeight
        const openaiH = (d.openai / max) * maxHeight
        return (
          <div key={d.date} className="flex-1 flex flex-col justify-end group relative min-w-[3px]">
            <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 hidden group-hover:block z-10 bg-warm-900 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap shadow-lg">
              {d.date}: {fmt$(d.total)}
            </div>
            <div className="bg-sky-400 rounded-t-sm" style={{ height: Math.max(groqH, 0.5) }} />
            <div className="bg-violet-400" style={{ height: Math.max(openaiH, 0.5) }} />
          </div>
        )
      })}
    </div>
  )
}

/* ─── horizontal bar chart ─── */
export function HorizontalBars({ items, colorFn }: { items: { label: string; value: number; max: number }[]; colorFn?: (i: number) => string }) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={item.label}>
          <div className="flex justify-between text-xs mb-0.5">
            <span className="text-warm-700 truncate mr-2">{item.label}</span>
            <span className="text-warm-500 shrink-0">{item.value}</span>
          </div>
          <div className="w-full bg-warm-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all ${colorFn ? colorFn(i) : 'bg-emerald-500'}`}
              style={{ width: `${item.max > 0 ? (item.value / item.max) * 100 : 0}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ─── pipeline visualization ─── */
const PIPELINE_STAGES = [
  { key: 'ingest',     label: 'Ingest',     icon: '📡', desc: 'RSS → Episodes' },
  { key: 'transcribe', label: 'Transcribe', icon: '🎙️', desc: 'Audio → Text' },
  { key: 'summarize',  label: 'Summarize',  icon: '🧠', desc: 'Text → Insights' },
] as const

interface JobCounts { active: number; waiting: number; completed: number; failed: number }

export function PipelineViz({ queues }: { queues: { ingest: JobCounts; transcribe: JobCounts; summarize: JobCounts } }) {
  return (
    <div className="flex items-stretch gap-0">
      {PIPELINE_STAGES.map((stage, i) => {
        const q = queues[stage.key]
        const isActive = q.active > 0
        const hasWaiting = q.waiting > 0
        return (
          <div key={stage.key} className="flex items-center flex-1">
            <div className={`
              flex-1 rounded-lg border-2 p-4 transition-all relative
              ${isActive
                ? 'border-blue-400 bg-blue-50 shadow-md shadow-blue-100'
                : hasWaiting
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-warm-200 bg-white'}
            `}>
              {isActive && (
                <div className="absolute top-2 right-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse" />
                </div>
              )}
              <div className="text-xl mb-1">{stage.icon}</div>
              <div className="font-semibold text-sm">{stage.label}</div>
              <div className="text-[11px] text-warm-500 mb-2">{stage.desc}</div>
              <div className="flex gap-2 text-[11px]">
                {isActive && (
                  <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">
                    {q.active} active
                  </span>
                )}
                {hasWaiting && (
                  <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded font-medium">
                    {q.waiting} queued
                  </span>
                )}
                {!isActive && !hasWaiting && (
                  <span className="px-1.5 py-0.5 bg-warm-100 text-warm-500 rounded">idle</span>
                )}
              </div>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className="px-1.5 text-warm-300 text-lg shrink-0">→</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* ─── donut chart (SVG) ─── */
export function DonutChart({ segments, size = 120 }: { segments: { label: string; value: number; color: string }[]; size?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) return <div className="text-xs text-warm-400 text-center py-4">No data</div>
  const r = (size / 2) - 8
  const circumference = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {segments.filter(s => s.value > 0).map((seg) => {
          const pct = seg.value / total
          const dashLen = pct * circumference
          const dashOffset = -offset * circumference
          offset += pct
          return (
            <circle
              key={seg.label}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={14}
              strokeDasharray={`${dashLen} ${circumference - dashLen}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )
        })}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" className="fill-warm-900 text-lg font-bold">{total}</text>
        <text x={size / 2} y={size / 2 + 12} textAnchor="middle" className="fill-warm-500 text-[10px]">episodes</text>
      </svg>
      <div className="space-y-1.5">
        {segments.filter(s => s.value > 0).map((seg) => (
          <div key={seg.label} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: seg.color }} />
            <span className="text-warm-600">{seg.label}</span>
            <span className="font-medium text-gray-900">{seg.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
