<!-- shared: structure — headings kept in sync across Migz93 self-hosted apps, content is app-specific -->

# Colour Scheme

ShelfBridge uses a fixed dark-mode palette defined as CSS custom properties in
`src/client/index.css` under the Tailwind v4 `@theme` block. Components reference
these via Tailwind utility classes (`bg-*`, `text-*`, `border-*`). The only
exception is overlays and gradients where a raw opacity value is needed and a
Tailwind class is impractical — those may use the CSS custom properties defined in
`:root` (e.g. gradient stop colours). Raw hex values in component JSX are not
permitted.

---

## The Palette

### Background scale

Six steps from darkest (page base) to lightest (hover states). Use in elevation
order — deeper backgrounds sit behind shallower ones.

| Variable | Hex | Role |
|---|---|---|
| `background` | `#0d0e12` | Page-level backgrounds, full-screen views, modal overlays |
| `background-container-low` | `#121318` | Sidebar, nav rail |
| `background-container` | `#18191e` | Default cards and panels |
| `background-container-high` | `#1e1f25` | Elevated cards, button resting state |
| `background-container-highest` | `#24252b` | Tooltips, popovers, highest elevation surfaces |
| `background-bright` | `#2a2c32` | Button hover state, interactive element hover |

### Brand / interactive

Two steps of the brand red. Use `primary-dim` for resting interactive states and
`primary` for hover only — this gives a consistent brighten-on-hover feel and
keeps resting contrast above WCAG AAA (7:1 against `on-surface`).

| Variable | Hex | Role |
|---|---|---|
| `primary` | `#e50914` | Hover state for buttons, active indicators, brand accent |
| `primary-dim` | `#ae0610` | Resting state: buttons, active nav item, selected filter chips, toggles |

### Text

| Variable | Hex | Role |
|---|---|---|
| `on-surface` | `#faf8fe` | Primary text; also text on coloured backgrounds (buttons, badges) |
| `on-surface-variant` | `#abaab0` | Secondary / muted text: subtitles, hints, inactive nav items |

### Border

| Variable | Hex | Role |
|---|---|---|
| `outline-variant` | `#47484c` | Borders and dividers; used at reduced opacity (`/15`, `/20`, `/30`) |

### Status

| Variable | Hex | Role |
|---|---|---|
| `success` | `#22c55e` | Success states, synced indicators, connected badges |
| `warning` | `#f59e0b` | Warnings: missing books, superseded writes, running sync pulse |
| `error` | `#f07070` | Errors, conflicts, failed connections, destructive actions |

---

## Contrast

All text/background pairings in active use pass WCAG AA (4.5:1 for normal text).

| Text | Background | Ratio |
|---|---|---|
| `on-surface` on any background step | worst case `background-bright` | 13.2:1 |
| `on-surface-variant` on any background step | worst case `background-bright` | 6.1:1 |
| `on-surface` on `primary-dim` (buttons, badges) | — | 7.0:1 (AAA) |
| `on-surface` on `primary` (hover) | — | 4.8:1 (AA) |

---

## Status Colour Usage In The UI

Status colours have specific jobs across the app:

| Colour | Where used |
|---|---|
| `success` | Connected badge, Synced health chip, CheckCircle icon, `written` events |
| `warning` | Missing health chip, Superseded health chip, running sync dot (animate-pulse), `superseded` and `conflict` events |
| `error` | Conflict health chip (BookDrawer), failed connection badge, error banner, `credential_failure` and `api_failure` events |

---

## Rules

- Never use `primary` or `primary-dim` as a text colour on dark backgrounds —
  neither passes AA at small text sizes against the background scale.
- Use `on-surface` (not raw `white`) for text on coloured backgrounds to keep
  the off-white tone consistent.
- Status colours (`success`, `warning`, `error`) are for text and subtle tinted
  backgrounds (`/10` opacity) only — do not use them as solid filled button
  backgrounds.
- `outline-variant` is a border colour only, never used for text.
- Animate-pulse on the warning dot is reserved for actively running syncs only —
  don't use it for static warning indicators.
