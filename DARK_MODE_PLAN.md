# Dark Mode Plan — QIR.KPFK.ORG

## Approach: System/Browser-Aware via `prefers-color-scheme`

No toggle button. Tailwind's `darkMode: 'media'` respects the user's OS/browser preference automatically. When system is set to dark, the app follows. When light, it stays light.

---

## 1. Tailwind Configuration Changes

**`tailwind.config.ts`**

```ts
darkMode: 'media',
```

Add dark-specific tokens to the theme:

```ts
colors: {
  // Existing warm palette stays as-is for light mode.
  // Add dark surface palette:
  surface: {
    DEFAULT: '#1C1A17',   // warm-900 — main page bg in dark
    raised: '#2A2722',    // warm-800 — cards, containers
    overlay: '#352F28',   // warm-700 — modals, dropdowns, popovers
    subtle: '#3F3B35',    // warm-700 — hover states on cards
  },
},
boxShadow: {
  // Dark mode shadows need higher opacity to register on dark bgs
  'card-dark': '0 1px 3px 0 rgba(0,0,0,0.3), 0 1px 2px -1px rgba(0,0,0,0.2)',
  'card-hover-dark': '0 4px 6px -1px rgba(0,0,0,0.4), 0 2px 4px -2px rgba(0,0,0,0.3)',
  'glow-red-dark': '0 0 0 3px rgba(217, 74, 94, 0.25)',
  'glow-gold-dark': '0 0 0 3px rgba(232, 201, 122, 0.2)',
},
```

---

## 2. Global CSS (`globals.css`) — Dark Overrides

### Base Layer

```css
@layer base {
  /* Dark mode selection */
  @media (prefers-color-scheme: dark) {
    ::selection {
      background-color: rgba(217, 74, 94, 0.3);
      color: #FAF9F7;
    }

    /* Scrollbar for dark */
    ::-webkit-scrollbar-thumb {
      background: #5C574F;          /* warm-600 */
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #7D7870;          /* warm-500 */
    }
  }
}
```

### Component Layer

```css
@layer components {
  /* Card — dark override */
  .card {
    @apply dark:bg-surface-raised dark:border-warm-700 dark:shadow-card-dark;
  }
  .card:hover {
    @apply dark:shadow-card-hover-dark;
  }

  /* Section header */
  .section-header {
    @apply dark:text-warm-500;
  }

  /* Log entry hover */
  .log-entry:hover {
    @apply dark:bg-warm-800/50;
  }

  /* Action buttons */
  .action-btn-primary {
    @apply dark:bg-warm-200 dark:text-warm-900 dark:hover:bg-warm-100 dark:active:bg-warm-300;
  }
  .action-btn-ghost {
    @apply dark:text-warm-300 dark:hover:bg-warm-700 dark:active:bg-warm-600;
  }
}
```

---

## 3. Color Mapping — Light to Dark

This is the core reference. Every light-mode color maps to a specific dark-mode counterpart. The goal: maintain **visual hierarchy** without ever placing dark on dark or light on light.

### Page & Container Backgrounds

| Element | Light | Dark | Notes |
|---|---|---|---|
| Page background | `bg-warm-50` | `dark:bg-surface` (warm-900) | Deepest layer |
| Card / container | `bg-white` | `dark:bg-surface-raised` (warm-800) | Must contrast against page bg |
| Nested container / table header | `bg-gray-50` / `bg-warm-100` | `dark:bg-warm-700` | Sits inside cards — must be lighter than card bg, not darker |
| Modal / popover | `bg-white` | `dark:bg-surface-overlay` (warm-700) | Above cards, needs separation |
| Hover on card row | `hover:bg-gray-50` | `dark:hover:bg-warm-700/50` | Subtle lift, not a full shade jump |
| Selected row | `bg-blue-50` | `dark:bg-blue-900/30` | Tinted, transparent, not opaque |

**Key rule:** Each nesting layer gets **progressively lighter** in dark mode (opposite of light mode). Page is darkest, cards are a step up, nested sections inside cards are lighter still.

### Text

| Element | Light | Dark | Contrast Ratio Target |
|---|---|---|---|
| Primary text | `text-warm-900` | `dark:text-warm-100` | ≥ 7:1 on surface-raised |
| Secondary text | `text-warm-600` / `text-warm-500` | `dark:text-warm-400` | ≥ 4.5:1 |
| Tertiary / caption | `text-warm-400` | `dark:text-warm-500` | ≥ 3:1 (decorative) |
| Heading in card | `text-gray-900` | `dark:text-warm-50` | High contrast |
| Link text | `text-blue-600` | `dark:text-blue-400` | Visible on dark bg |
| Muted / disabled | `text-gray-400` / `opacity-50` | `dark:text-warm-600` / `dark:opacity-60` | Intentionally lower |

### Borders

| Element | Light | Dark |
|---|---|---|
| Card border | `border-warm-200` | `dark:border-warm-700` |
| Dividers | `divide-y` (inherits gray) | `dark:divide-warm-700` |
| Input border | `border-warm-200` / `border-gray-300` | `dark:border-warm-600` |
| Focus ring | `ring-kpfk-red/20` | `dark:ring-kpfk-red-light/30` |
| Sidebar border | `border-sidebar-border` | No change (already dark) |

### Status Badges

Badges use tinted backgrounds with matching text. In dark mode, these become **transparent-tinted** to avoid blowing out contrast.

| Status | Light bg / text | Dark bg / text |
|---|---|---|
| Pending | `bg-amber-100 text-amber-800` | `dark:bg-amber-900/30 dark:text-amber-300` |
| Transcribed | `bg-blue-100 text-blue-800` | `dark:bg-blue-900/30 dark:text-blue-300` |
| Summarized | `bg-emerald-100 text-emerald-800` | `dark:bg-emerald-900/30 dark:text-emerald-300` |
| Failed | `bg-red-100 text-red-800` | `dark:bg-red-900/30 dark:text-red-300` |
| Unavailable | `bg-warm-200 text-warm-500` | `dark:bg-warm-700 dark:text-warm-400` |

**Pattern:** `bg-{color}-900/30` with `text-{color}-300`. The `/30` opacity lets the card background bleed through, preventing the badge from becoming an opaque dark block.

### Status Cell Backgrounds (Dashboard Overview)

| Status | Light | Dark |
|---|---|---|
| Pending | `bg-amber-50 border-amber-100` | `dark:bg-amber-900/20 dark:border-amber-800/40` |
| Transcribed | `bg-blue-50 border-blue-100` | `dark:bg-blue-900/20 dark:border-blue-800/40` |
| Summarized | `bg-emerald-50 border-emerald-100` | `dark:bg-emerald-900/20 dark:border-emerald-800/40` |
| Failed | `bg-red-50 border-red-100` | `dark:bg-red-900/20 dark:border-red-800/40` |

### Buttons

| Button Type | Light | Dark |
|---|---|---|
| Primary (dark bg) | `bg-warm-800 text-white` | `dark:bg-warm-200 dark:text-warm-900` | Inverts — dark button becomes light |
| Primary (colored) | `bg-gray-900 text-white` | `dark:bg-warm-100 dark:text-warm-900` |
| Ghost | `text-warm-600 hover:bg-warm-100` | `dark:text-warm-300 dark:hover:bg-warm-700` |
| Danger | `bg-red-600 text-white` | `dark:bg-red-700 dark:text-white` | Slightly muted red, white text stays |
| Success | `bg-green-600 text-white` | `dark:bg-green-700 dark:text-white` | Same approach |
| Secondary | `bg-gray-200 text-gray-700` | `dark:bg-warm-700 dark:text-warm-200` |
| Disabled | `opacity-40` | `dark:opacity-50` | Slightly higher so it's still visible |

### Form Inputs

| Element | Light | Dark |
|---|---|---|
| Input bg | `bg-warm-50` / `bg-white` | `dark:bg-warm-800` |
| Input border | `border-warm-200` | `dark:border-warm-600` |
| Input text | `text-warm-900` | `dark:text-warm-100` |
| Placeholder | implicit gray | `dark:placeholder-warm-500` |
| Focus border | `border-kpfk-red` | `dark:border-kpfk-red-light` |
| Focus ring | `ring-kpfk-red/20` | `dark:ring-kpfk-red-light/30` |

### Alerts & Callouts

| Type | Light bg / border / text | Dark bg / border / text |
|---|---|---|
| Error | `bg-red-50 / border-red-200 / text-red-700` | `dark:bg-red-900/20 / dark:border-red-800/40 / dark:text-red-300` |
| Warning | `bg-amber-50 / border-amber-200 / text-amber-700` | `dark:bg-amber-900/20 / dark:border-amber-800/40 / dark:text-amber-300` |
| Info | `bg-blue-50 / border-blue-200 / text-blue-700` | `dark:bg-blue-900/20 / dark:border-blue-800/40 / dark:text-blue-300` |
| Success | `bg-emerald-50 / border-emerald-200 / text-emerald-700` | `dark:bg-emerald-900/20 / dark:border-emerald-800/40 / dark:text-emerald-300` |

### Toasts

| Type | Light | Dark |
|---|---|---|
| Success | `bg-emerald-50 text-emerald-800 border-emerald-200` | `dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-700/50` |
| Error | `bg-red-50 text-red-800 border-red-200` | `dark:bg-red-900/40 dark:text-red-200 dark:border-red-700/50` |

### Charts & Data Viz (dashboard-charts.tsx)

| Element | Light | Dark |
|---|---|---|
| Chart bar (Groq) | `bg-sky-400` | `dark:bg-sky-500` | Bump saturation slightly |
| Chart bar (OpenAI) | `bg-violet-400` | `dark:bg-violet-500` |
| Tooltip | `bg-warm-900 text-white` | `dark:bg-warm-100 dark:text-warm-900` | Inverts |
| Bar track | `bg-warm-100` | `dark:bg-warm-700` |
| Bar fill | `bg-emerald-500` | `dark:bg-emerald-400` | Lighter for visibility |
| Donut labels | `text-warm-900` / `text-warm-500` | `dark:text-warm-100` / `dark:text-warm-400` |
| Pipeline active | `border-blue-400 bg-blue-50` | `dark:border-blue-500 dark:bg-blue-900/20` |
| Pipeline waiting | `border-amber-300 bg-amber-50` | `dark:border-amber-500 dark:bg-amber-900/20` |
| Pipeline idle | `border-warm-200 bg-white` | `dark:border-warm-600 dark:bg-surface-raised` |

### Highlights & Search

| Element | Light | Dark |
|---|---|---|
| Search highlight | `bg-yellow-200` | `dark:bg-yellow-700/50 dark:text-yellow-100` |
| Compliance highlight | `bg-amber-200 ring-amber-300` | `dark:bg-amber-800/40 dark:ring-amber-600` |
| Active caption | `bg-blue-100 text-blue-900` | `dark:bg-blue-900/30 dark:text-blue-200` |

---

## 4. Sidebar — No Changes Needed

The sidebar is already dark (`bg-sidebar-bg: #191817`). Its entire palette (hover, active, border, text) is designed for a dark surface. **No `dark:` overrides needed** for sidebar elements.

The only adjustment: in dark mode the sidebar border against the main content area becomes invisible (dark-on-dark). Fix:

```
border-r border-sidebar-border dark:border-warm-700
```

This gives just enough separation without being jarring.

---

## 5. Login Page

| Element | Light | Dark |
|---|---|---|
| Page bg | `bg-warm-50` | `dark:bg-surface` |
| Card | `bg-white border-warm-200` | `dark:bg-surface-raised dark:border-warm-700` |
| Logo badge | `bg-kpfk-red` | No change (brand color stays) |
| Input bg | `bg-warm-50` | `dark:bg-warm-800` |
| Submit button | `bg-warm-800 text-white` | `dark:bg-warm-200 dark:text-warm-900` |

---

## 6. Public QIR Pages (`[year]/q[quarter]/page.tsx`)

These are print-friendly report pages. Dark mode applies for screen viewing but `@media print` should force light mode:

```css
@media print {
  /* Force light backgrounds for printing regardless of system preference */
  * {
    background-color: white !important;
    color: black !important;
    border-color: #ccc !important;
  }
}
```

For screen in dark mode: same card/surface pattern as dashboard.

---

## 7. Implementation Order

### Phase 1 — Foundation
1. Add `darkMode: 'media'` to `tailwind.config.ts`
2. Add `surface` color tokens and dark shadow variants to theme
3. Update `globals.css` base layer (selection, scrollbar) with dark overrides
4. Update `globals.css` component layer (`.card`, `.action-btn-*`, `.log-entry`, `.section-header`)

### Phase 2 — Layout Shell
5. `app/layout.tsx` — `dark:bg-surface dark:text-warm-100` on body
6. `app/dashboard/layout.tsx` — sidebar border fix, mobile header (already dark), main content area background
7. `app/login/page.tsx` — card, inputs, button inversions

### Phase 3 — Shared Components
8. `skeleton.tsx` — `dark:bg-surface-raised`, pulse blocks `dark:bg-warm-700`
9. `error-boundary.tsx` — dark alert colors
10. `empty-state.tsx` — dark card, dark button inversion
11. `confirm-dialog.tsx` — dark overlay, dark dialog surface, button inversions
12. `toast.tsx` — dark toast backgrounds
13. `breadcrumbs.tsx` — dark text colors
14. `episode-media.tsx` — player, captions, transcript viewer
15. `dashboard-charts.tsx` — all chart elements, tooltips, pipeline viz
16. `qir-report-view.tsx` — report containers, edit mode
17. `transcript-corrections.tsx` — form, table, test area

### Phase 4 — Dashboard Pages
18. `dashboard/page.tsx` — status badges, status cells, stat cards, activity feed
19. `episodes/page.tsx` — table, filters, bulk actions, pagination, kbd hints
20. `episodes/[id]/page.tsx` — detail view, compliance flags, edit mode
21. `jobs/page.tsx` — queue cards
22. `generate/page.tsx` — validation checks, draft list, finalization checklist
23. `compliance/page.tsx` — severity badges, health scores, table, bulk actions
24. `usage/page.tsx` — cost tables/charts
25. `downloads/page.tsx` — export cards
26. `settings/page.tsx` — settings forms

### Phase 5 — Public & Print
27. Public QIR pages — dark surface for screen, print override to force light

---

## 8. Contrast Danger Zones — Watch List

These are the spots most likely to produce dark-on-dark or light-on-light problems:

1. **`bg-gray-50` inside `bg-white` cards** — In dark mode, if both become similar dark shades, the nested section vanishes. Solution: card is `surface-raised` (warm-800), nested section is `warm-700` — visible step.

2. **Status badges on status cells** — Both use tinted backgrounds. If both use opaque dark versions, the badge disappears into the cell. Solution: cells use `{color}-900/20`, badges use `{color}-900/30` — the badge is always slightly more saturated.

3. **`text-warm-400` captions on dark backgrounds** — warm-400 is `#A8A39B`. On `surface-raised` (#2A2722), contrast ratio is ~4.2:1. Acceptable for secondary text (WCAG AA for large text) but tight. Bump to `text-warm-500` in dark mode if needed after visual testing.

4. **White text on colored buttons** — `bg-red-600 text-white` works in both modes. But `bg-green-600 text-white` can be tight. Using `bg-green-700` in dark mode helps.

5. **Tooltip inversion** — Light mode tooltip is `bg-warm-900 text-white`. If dark mode page bg is also warm-900, tooltip is invisible. Solution: invert tooltip to `bg-warm-100 text-warm-900` in dark mode.

6. **Form inputs inside cards** — If input bg matches card bg (both warm-800), the input borders are the only cue. Make sure `border-warm-600` is always present on inputs in dark mode, never `border-transparent`.

7. **Selected row highlight** — `bg-blue-50` in light is obvious. `bg-blue-900/30` in dark mode on `surface-raised` needs to be visually distinct. Test that the `/30` opacity produces enough tint.

8. **Sidebar-to-content boundary** — Both are dark. The `border-r` must be visible. `dark:border-warm-700` against sidebar-bg (#191817) gives enough contrast.

---

## 9. What NOT to Change

- **Brand colors** (`kpfk-red`, `kpfk-gold`) — These stay the same. The red logo, gold accents, and red focus rings are brand identity.
- **Sidebar palette** — Already dark-themed. No `dark:` variants needed on sidebar internals.
- **Animation/transition values** — Timing and easing are mode-independent.
- **Font sizes, spacing, layout** — Dark mode is purely a color concern.
- **Semantic status colors** — Red=failed, amber=pending, blue=processing, green=complete. The hues stay; only lightness/opacity shifts.
