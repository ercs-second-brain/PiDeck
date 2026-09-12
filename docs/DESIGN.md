# PiDeck web — design

The webapp is a terminal multiplexer with a sidebar and a few settings pages. It should feel like
one calm dark surface where pi's own TUI is the star. This document is binding for every web
issue; when a screen needs something not covered here, extend this document first.

## Principles

1. **The terminal is the product.** Everything else is chrome; chrome is quiet, dense, and never
   competes with the pane. One surface colour, one accent, state colours only for state.
2. **Composition over per-screen CSS.** Every screen is built from the primitives in §4. If a
   screen needs a new primitive, add it here and to `src/ui/` — never a one-off class.
3. **Mobile is a first-class client**, not a breakpoint. Reading terminals *and* holding full
   conversations with the orchestrator from a phone must both be comfortable.
4. **Pages, not modals.** Settings, onboarding, and logs live at URLs in the main pane. Modals are
   for confirmations (terminate, delete project) and the update-in-progress overlay only.

## 1. Tokens (plain CSS, `src/index.css :root`)

Dark only. Plain CSS with custom properties; no CSS framework, no component library.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#0c0d10` | App and terminal background — identical, so the pane never reads as a box |
| `--bg-raised` | `#13151a` | Sidebar, header, settings cards |
| `--bg-hover` | `#1a1d24` | Hover / selected rows, wells |
| `--border` | `#262a33` | All 1px borders |
| `--text` | `#f4f5f7` | Primary text |
| `--text-dim` | `#8b93a0` | Secondary text, labels, hints, empty states |
| `--accent` | `#f59f4c` | Brand, primary action, focus ring, cursor (AO's warm amber) |
| `--green` | `#44c97a` | ready / merged / success |
| `--red` | `#f05d5e` | blocked / failed / destructive |
| `--amber` | `#e5c34b` | ci / fixing / addressing (in progress) |
| `--blue` | `#5b9cff` | working / links / issue numbers |
| `--purple` | `#c678dd` | in review / PR numbers |

Type: `--font-ui` system sans; `--font-mono` a Nerd-Font-capable mono stack
(`"JetBrainsMono Nerd Font", "FiraCode Nerd Font", ui-monospace, Menlo, monospace`). Scale (px):
11, 12, 13, 14 (base), 16, 18, 22. Spacing on a 4px grid. Radius 6px (controls), 10px (cards),
999px (badges). One shadow for popovers, one for modals. Tints via
`color-mix(in srgb, <token> 15%, transparent)`, never hand-rolled rgba.

## 2. Terminal

Port agent-orchestrator's xterm configuration verbatim — it is why pi looks right there:

- Renderer: **WebGL addon**, canvas fallback; never the DOM renderer.
- `drawBoldTextInBrightColors: true`, `minimumContrastRatio: 1` (no recolouring of TUI output),
  `allowProposedApi: true`, Unicode 11 addon, `cursorBlink: true`, `scrollback: 5000`.
- `fontSize` 13 desktop / 12 mobile, `lineHeight` 1.35, font from `--font-mono`.
- ANSI palette (One Dark–derived, from AO `theme.ts` `darkTerminal`): bg/`black` `#0c0d10`,
  fg `#f4f5f7`, cursor `#f59f4c`, red `#f05d5e`, green `#44c97a`, yellow `#e5c34b`, blue
  `#5b9cff`, magenta `#c678dd`, cyan `#56b6c2`, white `#d7dae0`, brightBlack `#7f8792`,
  brightRed `#ff7b7c`, brightGreen `#62df91`, brightYellow `#f2d66d`, brightBlue `#79b1ff`,
  brightMagenta `#d99aee`, brightCyan `#79d4df`, brightWhite `#f4f5f7`. `black` is collapsed into
  the background on purpose.

**Scrolling — do not copy AO here.** AO attaches a tmux *client* and fakes scrolling by
translating wheel/touch into tmux copy-mode, which lags and jumps. PiDeck instead:

- The daemon streams raw pane output with `tmux pipe-pane` into a per-session ring buffer
  (~2 MB) and forwards it over the WebSocket; input goes back via `tmux send-keys`.
- Sessions are created at 200×50 with `window-size manual`, so a pane running unattached never
  renders at tmux's 80×24 default. On attach the daemon resizes the window to the client's size
  before replaying; when the size changed, the replay is a fresh `capture-pane -e -p` of the
  redrawn screen (the ring buffer replays only when sizes already match).
- xterm owns scrollback locally. Scrolling is native for mouse, trackpad, and touch. A
  "jump to bottom" pill appears when scrolled up; new output does not yank the view while the
  user is reading history.
- pi's TUI owns its own scrolling: for pi panes xterm's scrollback stays intentionally empty,
  so "can't scroll up" is expected, not a bug — scroll inside the TUI.
- Reconnect replays the ring buffer, then resumes live.

Mobile terminal: fills the viewport under the header; with the on-screen keyboard open the pane
shrinks (`100dvh` + `visualViewport`), never scrolls the page. A key row above the keyboard:
`Esc · Tab · Ctrl · ↑ · ↓ · ← · → · ⏎` at ≥ 40px targets. A composer field (multi-line, sends on
⏎, Shift+⏎ newline) is the primary way to type on phones; direct xterm input remains available.

## 3. Layout

**Desktop (≥ 900px):** header 44px; sidebar 280px (collapsible to 0 with a header toggle,
remembered); main pane fills the rest and hosts exactly one of: terminal, settings page,
onboarding, log viewer, empty state.

**Mobile (< 900px):** two full-screen views, not a drawer. The sidebar *is* the home screen (a
list); tapping a row navigates to `/sessions/:id` full-screen with a back button in the header.
Browser back returns to the list. Settings pages are likewise full-screen.

### Sidebar

```
● PiDeck                                    ⚙  ⟳
─────────────────────────────────────────────
▸ Global agent                              ●
▾ my-api                                    ⋯
    Orchestrator                            ●
    #42  Add rate limiting            fixing ●
       ↳ Reviewer                  in review ●
    #47  Fix flaky test              working ●
    ▸ Archived (3)
▾ my-web                                    ⋯
    Orchestrator                            ●
    Start orchestrator
+ Add project
```

- Rows are 36px (44px on touch), `--fs-md`, one line, ellipsised; issue number in `--blue` mono.
  A worker or reviewer with a user-given label shows that instead of `#N title`.
- Nesting by indent only (16px per level) plus a `↳` glyph for reviewers under their worker.
- State badge at the right: an 8px circle in the state's colour, the state wording in a hover
  tooltip and as the `aria-label`. States and colours: `working` blue · `ci` amber · `fixing`
  amber · `in review` purple · `addressing` amber · `ready` green · `blocked` red · `done` dim.
- The selected row has `--bg-hover` plus a 2px accent bar on the left edge.
- `⋯` on a project row: Settings, Open on GitHub, Delete project. Long-press on touch.
- `⋯` on a worker or reviewer row: Rename… (inline edit; persists as the row's label), GitHub
  links, Terminate.
- Live via WS; a tiny relative timestamp ("2m") in `--text-dim` mono on hover shows last activity.
- Archived sessions fold into a per-project `▸ Archived (n)` group (collapsed by default, remembers
  open/closed per project); inside it rows render exactly like live rows — same primitives, indent
  and `↳` nesting, real `label ?? #N title` text, a `dim` dot whose tooltip reads
  "done · archived <relative time>" — and a selected archived row gets the same accent bar.
- `+ Add project` is the last row, styled like the other rows (36px, 44px on touch); the sidebar
  row is the only entry point — the header has no `+`.

### Header

Left: sidebar toggle (desktop) or back (mobile) + current context (project › session name).
Right: update pill when available, settings gear. Nothing else.

## 4. Primitives (`src/ui/`)

Exactly these, reused everywhere; each is a small component with its own CSS file:

`Page` (title + optional sub-nav + content column, max 640px, 24px padding) ·
`Section` (uppercase 12px title, description, children, optional footer with Save + status) ·
`Row` (label + description left, control right; stacks on < 480px) ·
`Field` (text / number / password inputs and selects, 36px tall, 40px on touch, 16px font on
touch to prevent iOS zoom) · `Switch` (real checkbox, `role="switch"`) · `Button`
(default / primary / danger / ghost) · `Badge` (state pill) · `Dialog` (confirmations only) ·
`Empty` (dim one-liner + optional CTA) · `Toast` (bottom-right, bottom-centre on mobile).

Props are plain values — no context, no styling API. These signatures are binding for every
screen built on the primitives:

| Primitive | Props |
| --- | --- |
| `Page` | `title: string` · `subnav?: ReactNode` · `children` |
| `Section` | `title?: string` · `description?: string` · `footer?: ReactNode` (Save + status) · `children` |
| `Row` | `label: string` · `description?: string` · `children` (the control) |
| `Field` | `value: string` (always a string; consumers parse numbers) · `onChange(value: string)` · `type?: "text" \| "password" \| "number" \| "select"` · `options?: { value, label }[]` (select only) · `placeholder?` · `disabled?` · `min?` · `max?` · `step?` · `error?: string` (inline under the control in `--red`) · `label?: string` (accessible name) |
| `Switch` | `checked: boolean` · `onChange(checked: boolean)` · `label: string` (accessible name) |
| `Button` | `variant?: "default" \| "primary" \| "danger" \| "ghost"` · `type?: "button" \| "submit"` · `disabled?` · `autoFocus?` · `onClick?` · `children` |
| `Badge` | `tone: "blue" \| "amber" \| "purple" \| "green" \| "red" \| "dim"` · `dot?: boolean` (8px circle in the tone's colour; `children` become the `title` and `aria-label` instead of visible text) · `children` |
| `Dialog` | `open: boolean` · `title: string` · `children?` (description line) · `confirmLabel?: string` (default "Confirm") · `danger?: boolean` · `busy?: boolean` (disables the buttons while the confirmed action runs) · `onConfirm` · `onCancel` |
| `Empty` | `children` (the dim one-liner) · `action?: ReactNode` (CTA button) |
| `Toast` | `message: string \| null` · `onDismiss?: () => void` (auto-dismisses after 3 s when given) |

Worker states map to badge tones via `src/ui/tones.ts` (`stateBadge(state)` → tone + label),
never hand-rolled by a screen: `working` blue · `ci`/`fixing`/`addressing` amber ·
`in_review` purple (labelled "in review") · `ready` green · `blocked` red · `done` dim. The
sidebar shows them as dots; other screens use the full-text pill.

## 5. Screens

**Settings** (`/settings`, sub-nav: General · Review account · Models · Prompts):
- General: poll interval (read-only display), state dir, daemon version, "Check for updates".
- Review account: username, token (write-only, shows "set" / "not set"), Verify, Save.
- Models: four `Row`s, one per persona, each a select of pi's models with "pi default".
- Prompts: persona tabs; a full-height mono textarea; "Shipped" / "Edited" indicator; Save,
  Reset to default (confirm). Placeholder list in a collapsible aside.

**Project settings** (`/projects/:id/settings`): one `Page`, one `Section` with the five knobs as
`Row`s, Save; a danger `Section` with Delete project.

**Onboarding** (`/onboarding`): a `Page` with a 4-step chip stepper (pi · GitHub · Review account
· Repo). Each step is one `Section` with its probe result, instructions when not ready, and a
Re-check button; Next enables only when the step passes. Re-entering later jumps to Repo.

**Log viewer** (`/sessions/:id` for archived sessions): header shows persona, issue/PR link,
spawned/archived, final state; body is a read-only xterm with the captured log.

**Empty states**: no projects → centred `Empty` with "Add project"; project without orchestrator →
row-level "Start orchestrator" button.

## 6. Interaction rules

- Touch targets ≥ 40px on touch viewports; hover-only affordances get a visible fallback there.
- Focus ring: 2px accent, `:focus-visible` only; never removed.
- Every async action shows its state on the control that triggered it (spinner, then "Saved"
  for 2 s); errors inline under the control in `--red`, never as alerts.
- Destructive actions confirm in a `Dialog` naming the object ("Delete project my-api?").
- Text containers get `min-width: 0` and ellipsis; long paths/branches wrap with
  `overflow-wrap: anywhere` inside their box — the page never scrolls horizontally.
- Safe areas: `viewport-fit=cover` and `env(safe-area-inset-*)` on header, key row, toasts.
