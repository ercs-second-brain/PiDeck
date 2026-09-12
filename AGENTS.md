# AGENTS.md

Rules for every agent working in this repo. Read `docs/SPEC.md` for the spec of record.

## Engineering rules

- Simplicity is the product. Every module must be explainable in one paragraph in this document.
- No comments that cite issue numbers. Code explains itself or the doc explains it.
- No settings without a stated user who needs them.
- GitHub is the source of truth; PiDeck persists only what GitHub cannot tell it.

## Checks

Node >= 22; pnpm is pinned via `packageManager` in the root `package.json`.

    pnpm lint        # eslint (typescript-eslint, flat config)
    pnpm build       # build every workspace package
    pnpm typecheck   # tsc --noEmit in every workspace package (needs build output)
    pnpm test        # vitest

All four must pass before you push or open a PR. In CI they run in the order
lint → build → typecheck → test.

## UI gallery

Before opening any PR that touches the web app, run `pnpm build && pnpm
ui-gallery --assert` (first time: `npx playwright install chromium`; needs
Chromium, so it never runs in CI) and read `runs/ui/<timestamp>/index.html`
against `docs/DESIGN.md` — every route and state at desktop and mobile widths,
each shot labelled with the section it should be judged against, layout
assertions running alongside. It boots the real daemon against the fake `gh`
and a fake tmux with a seeded state, in about a minute; see
`tools/ui-gallery/README.md`. Anything the gallery or the assertions surface
becomes its own issue — the tool documents, it does not fix.

## Live check

After any prompt, reconciler, or session change, also run the loop once against real GitHub:

    pnpm e2e           # happy path; --scenario blocked|restart for the other legs; --keep keeps the repo

Needs the primary `gh` auth and the review account's PAT in `PD_E2E_REVIEW_TOKEN` (never
printed). It builds, pushes `tools/e2e/fixture/` to a private throwaway repo `pideck-e2e-<ts>`,
registers it in a throwaway daemon, asserts the scenario on GitHub facts and `/api/sessions`,
collects every transcript into `runs/<ts>/`, and deletes the throwaway repo unless `--keep`.
Needs real GitHub and
real models — it is not part of CI; it is the pre-merge check for prompt/reconciler/session work.

