# PiDeck web — design tokens & rules

The webapp is plain CSS (no framework) with one token block in `src/index.css`
(`:root`) shared by every surface. This doc records the tokens and the rules
that keep the UI cohesive (issue #294). When touching any surface, reuse these
instead of introducing new one-off values.

## Palette

Dark, terminal-adjacent. `#0f1216` is the app background, `#e05d44` the accent.

| Token          | Value     | Role                                        |
| -------------- | --------- | ------------------------------------------- |
| `--bg`         | `#0f1216` | App/pane background, card bodies            |
| `--bg-raised`  | `#161b22` | Raised surfaces: header, sidebar, modals    |
| `--bg-hover`   | `#1c2330` | Hover/selected state, subtle wells          |
| `--border`     | `#2a3038` | All 1px borders                             |
| `--text`       | `#e6e2d8` | Primary text                                |
| `--text-dim`   | `#8b949e` | Secondary text, labels, hints, empty states |
| `--accent`     | `#e05d44` | Brand, primary action, focus ring           |
| `--issue`      | `#4c8dff` | Issue/worker semantics                      |
| `--pr`         | `#b07cff` | PR semantics                                |
| `--green`      | `#3fb950` | Success / merged / attached                 |
| `--red`        | `#f85149` | Destructive / failure                       |
| `--amber`      | `#d29922` | In-progress / warning                       |

Rules:

- Semantic tints are always `color-mix(in srgb, <token> N%, transparent)` —
  never hardcoded rgba of a token's value.
- Every surface sits on `--bg` or `--bg-raised`; hover/selection is
  `--bg-hover` (plus an accent border where selection must read at a glance).
- One accent color per surface; green/red/amber only carry state semantics.

## Typography

- `--font-ui` — sans stack for everything; `--font-mono` — for terminal-adjacent
  data: session names, paths, durations, diff content.
- Type scale (tokens): `--fs-2xs` 10, `--fs-xs` 11, `--fs-sm` 12, `--fs-md` 13,
  `--fs-base` 14, `--fs-lg` 16, `--fs-xl` 18, `--fs-2xl` 22 (px).
- Hierarchy: page title `--fs-2xl`, modal title `--fs-xl`, section/panel titles
  `--fs-base` + uppercase + letter-spacing, body `--fs-base`/`--fs-md`, meta and
  hints `--fs-sm`, badges `--fs-xs`.
- Numeric data that ticks or aligns (durations, counts) uses `--font-mono` +
  `font-variant-numeric: tabular-nums`.

## Spacing

4px grid. Allowed steps: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28. Component
padding defaults: dense rows `8px 10px`, cards `10px 12px`, panels `14px 18px`,
modals `24px 28px`. Gaps inside a row: 4–10px; between sections: 16–28px.

## Shape, shadow, layers

- Radius: `--radius` 8px (cards, inputs, buttons, menus), `--radius-sm` 4px
  (inline code, tiny chrome), `--radius-pill` 999px (badges, step chips).
- Shadows (dropdown/popover): `--shadow-pop`; (modal): `--shadow-modal`. Never
  invent new shadows.
- Backdrop dim for modals/drawers: `--backdrop`.
- z-index ladder: `--z-sticky` 10 < `--z-overlay` 30 < `--z-pop` 40 <
  `--z-notif` 45 < `--z-modal` 50 < `--z-critical` 60.

## Controls

- Buttons: `.button` (+ `.button-primary`); hover = accent border + `--bg-hover`.
- Toggles: ONE component, `components/Toggle.tsx` (issue #359) — a real
  checkbox input (`role="switch"`, visually hidden but focusable: tab +
  space are the platform's), a decorative track/thumb, and the row's label.
  The track's on state is the accent; the focus-visible ring mirrors onto
  the track. Never use a raw checkbox in the non-terminal UI.
- Icon buttons (bell, hamburger, chat/⋯): 40×40 on touch viewports, quiet
  `--text-dim` glyph that takes accent on hover; destructive hover is red.
- Touch targets ≥ 40×40 on `≤ 768px`; inline text affordances get padded,
  negative-margined hit areas instead of visual growth. Toggle rows,
  buttons, inputs, and selects are ≥ 40px tall there; the toggle switch
  itself grows to 40×24.
- Focus: the global `:focus-visible` outline (accent, 2px) is the only focus
  treatment — never `outline: none` without a replacement.
- Inputs/selects: shared `.field` chrome (1px `--border`, `--radius`, `--bg`);
  16px font on `≤ 768px` so iOS Safari does not zoom on focus.

## Modals

- Chrome: `.modal-overlay` + `.modal-card` (`--shadow-modal`, `--border`
  edge, `--radius`) + `.modal-close` — the AssetDialog standard every modal
  shares (settings, agent assets, onboarding, nested dialogs, the update
  modal, which only centers its card and runs on `--z-critical`).
- Title: `.modal-title` (`--fs-xl`, weight 650). Section headings inside a
  modal/panel stay `.section-title` (quiet uppercase `--fs-base`).

## Layout & responsiveness

- App shell: full-height (`100dvh`) flex; sidebar 280px, main pane fills.
- Breakpoints: `1024px` (board 4→2 columns), `768px` (drawer, touch targets,
  input zoom), `640px` (board 1 column, full-width toasts).
- Flex/grid children that hold text always get `min-width: 0` (or
  `overflow: hidden`) so long names/paths ellipsize or wrap instead of
  stretching the layout.
- Long unbroken strings (branches, URLs, commands) use `overflow-wrap: anywhere`
  or a horizontal scroll container — never force page-level scroll.
- iOS PWA: `viewport-fit=cover` + `env(safe-area-inset-*)` padding on every
  edge-anchored surface (header top, key row/footer bottom, toasts).
- Empty states: `--text-dim`, one short sentence, optionally one CTA button.

## Terminal theme (issues #299 + #376)

The xterm pane (`src/terminal/terminal-theme.ts`) keeps the app's own surface
but follows agent-orchestrator's terminal rule that the ANSI palette is
*independent* from product colors — agent TUIs own the semantic meaning of
the slots, so output colors match a native terminal:

- `background`/`foreground` are the app's `--bg`/`--text`; cursor =
  foreground, cursorAccent = bg; selection is a translucent wash of the app's
  issue blue so selected text keeps its own colors.
- The 16 ANSI colors are a standard-hue, One Dark–derived set
  (agent-orchestrator's dark terminal palette; its `#101317` plate is a
  near-identical surface to `#0f1216`). No slot is mapped to a product token
  (the old accent-red/issue-blue mapping is gone); ANSI `black` collapses
  into the plate so TUIs that fill rows with black don't paint stripes; each
  normal slot that can appear as foreground text is readable on the plate on
  its own, with brights lighter than their normals.
- `minimumContrastRatio: 1` — NO forced contrast transform. xterm's contrast
  feature rewrites each cell's foreground per render against that cell's
  local background, so the same ANSI color rendered differently inside TUI
  highlight blocks/selections and shifted as those moved (issue #376's
  "colors move around"). The palette is readable without runtime rewriting.
- Renderer: WebGL, falling back to 2D canvas, then xterm's DOM renderer
  (`loadRenderer` in TerminalPane). Both canvas renderers rasterize
  box-drawing on a fixed cell grid — no per-span boxes snapping on
  fractional-DPR displays, so the old 1px-overfill seam fix only matters
  when the DOM fallback path is live. Never remove that rule without
  reintroducing the coverage guarantee another way.
