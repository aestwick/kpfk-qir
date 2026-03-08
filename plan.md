# Implementation Plan: Dashboard Redesign + Global Style System

## Overview

Incorporate the two `ideas/` prototypes into the live app and establish a global design system based on the warm editorial palette from `qir-dashboard-redesign.jsx`. Replace the current default gray Tailwind look with the KPFK-specific design language across all pages.

---

## Phase 1: Design Tokens & Global Styles

### 1.1 Update `tailwind.config.ts` — new color palette + typography

Replace the existing `kpfk-*` colors with the redesign's full palette:

```
colors:
  brand:
    dark:    '#2D2519'   (sidebar bg, primary buttons, headings)
    medium:  '#3D3229'   (sidebar active, elevated dark surfaces)
    muted:   '#7A6E60'   (secondary text)
    subtle:  '#A89B8C'   (tertiary text, labels)
    border:  '#C4B99A'   (borders, dividers)
    light:   '#E2D9CA'   (card borders)
    cream:   '#E8E0D4'   (progress track bg, light surfaces)
    sand:    '#F5F0E8'   (page background)
    paper:   '#FFFDF8'   (card backgrounds)
  accent:
    teal:    '#4B7D8D'   (primary accent — progress, links, transcribe stage)
    gold:    '#C4913E'   (secondary accent — active nav, ingest stage)
    red:     '#D4634B'   (error, destructive, Middle East issue)
    green:   '#6B8F71'   (success, summarize stage)
fontFamily:
  display: ['Playfair Display', 'serif']
  body:    ['DM Sans', 'sans-serif']
```

### 1.2 Update `app/globals.css` — base styles + font imports

- Import DM Sans + Playfair Display from Google Fonts via `@import`
- Set `body` defaults: `font-family: 'DM Sans'`, `background: sand`, `color: brand-dark`
- Add utility classes for common patterns (`.card`, `.section-label`, `.status-dot`)

### 1.3 Update `app/layout.tsx` — apply font classes

- Remove `bg-gray-50 text-gray-900`, use new defaults from globals.css
- Add `font-body` class to body

---

## Phase 2: Shared Components — Extract from Prototypes

### 2.1 `app/components/pipeline-visualizer.tsx` — canvas particle viz

Extract `PipelineVisualizer` from `ideas/qir-pipeline-v2.jsx`:
- Accept props: `mode`, `isRunning`, `episodes` (real data from API)
- Keep `rgbStr`, `lerpColor`, `easeOutCubic` as local utils
- Map real episode names/statuses to particle stages
- Export as `'use client'` component

### 2.2 `app/components/ui/progress-ring.tsx`

Extract the SVG progress ring from the redesign. Props: `value`, `max`, `size`, `color`.

### 2.3 `app/components/ui/issue-bar.tsx`

Extract the horizontal bar chart for issue coverage. Props: `name`, `count`, `maxCount`, `color`.

### 2.4 `app/components/ui/status-dot.tsx`

Small status indicator dot. Props: `status`. Replaces inline colored dots used across pages.

---

## Phase 3: Dashboard Layout Redesign

### 3.1 Update `app/dashboard/layout.tsx` — new sidebar

Restyle the sidebar to match the redesign:
- Background: `brand-dark` (#2D2519)
- Logo area: Playfair Display "QIR" + "KPFK 90.7 FM" subtitle
- Quarter selector dropdown (styled dark surface)
- Nav items: left border accent on active (`accent-gold`), icon + label
- Bottom: Settings link + user email
- Keep existing mobile hamburger behavior, restyle to match

### 3.2 Update `app/dashboard/page.tsx` — overview redesign

Restructure to match `qir-dashboard-redesign.jsx` layout, wired to real data:

1. **Header**: Playfair Display title + quarter range + "Generate QIR" / "Export PDF" buttons
2. **Pipeline section**: Embed `PipelineVisualizer` (canvas) with run controls, replace the current emoji-based pipeline cards
3. **Stats row** (3-col grid):
   - Quarter Progress (ProgressRing) — from existing episode counts
   - Cost This Quarter — from existing usage API
   - Avg Processing Time — from existing stats
4. **Bottom row** (1:2 grid):
   - Issues Coverage (IssueBar components) — from existing category data
   - Recent Episodes table — from existing episode list API

### 3.3 Update `app/components/dashboard-charts.tsx`

Replace or adapt `MiniBarChart`, `PipelineViz`, `DonutChart` to use new color tokens. The canvas `PipelineVisualizer` replaces the old `PipelineViz` component.

---

## Phase 4: Restyle Remaining Dashboard Pages

Apply the new design tokens across all pages. This is primarily a Tailwind class replacement — no structural changes.

### Color mapping (old → new):
```
bg-gray-50        → bg-brand-sand
bg-white          → bg-brand-paper
bg-gray-900       → bg-brand-dark
text-gray-900     → text-brand-dark
text-gray-600     → text-brand-muted
text-gray-400     → text-brand-subtle
border-gray-200   → border-brand-light
border-gray-300   → border-brand-border
hover:bg-gray-50  → hover:bg-brand-cream
emerald-*         → accent-green
blue-*            → accent-teal
amber-*           → accent-gold
red-*             → accent-red
```

### Pages to update (in order):
1. **Episodes list** (`episodes/page.tsx`) — table, filters, status badges
2. **Episode detail** (`episodes/[id]/page.tsx`) — audio player, transcript, metadata cards
3. **Jobs** (`jobs/page.tsx`) — queue cards, status indicators
4. **Generate QIR** (`generate/page.tsx`) — draft builder, validation checklist
5. **Usage** (`usage/page.tsx`) — cost cards, daily spend table
6. **Settings** (`settings/page.tsx`) — forms, toggles, correction table
7. **Downloads** (`downloads/page.tsx`) — export cards
8. **Activity** (`activity/page.tsx`) — activity feed

### Shared components to restyle:
- `skeleton.tsx` — use `brand-cream` for pulse bg
- `empty-state.tsx` — use `brand-paper` card, `accent-teal` button
- `toast.tsx` — use `accent-green` / `accent-red`
- `confirm-dialog.tsx` — use `brand-paper` bg, `brand-dark` buttons
- `breadcrumbs.tsx` — use `brand-muted` / `brand-subtle` text
- `episode-media.tsx` — restyle player and transcript viewer
- `qir-report-view.tsx` — restyle category headers with accent colors
- `transcript-corrections.tsx` — restyle form and table

---

## Phase 5: Public Pages & Login

### 5.1 Login page (`app/login/page.tsx`)
- Background: `brand-sand`
- Card: `brand-paper` with `brand-light` border
- Button: `brand-dark` bg
- Add KPFK logo/branding above form

### 5.2 Public QIR page (`app/[year]/q[quarter]/page.tsx`)
- Light restyle: use `font-display` for heading, `brand-*` colors for text
- Keep print-friendly — no heavy styling changes
- Update category header colors to match `accent-*` palette

---

## Execution Order

| Step | What | Files |
|------|------|-------|
| 1 | Tailwind config + globals.css + root layout | 3 files |
| 2 | Extract shared components from prototypes | 4 new files |
| 3 | Dashboard layout (sidebar) | 1 file |
| 4 | Dashboard overview page | 1 file + charts update |
| 5 | Episodes list + detail | 2 files |
| 6 | Jobs, Generate, Usage, Settings, Downloads, Activity | 6 files |
| 7 | Shared components restyle | 8 files |
| 8 | Login + public QIR page | 2 files |

~27 files touched total. No API or backend changes needed — this is purely UI/styling.
