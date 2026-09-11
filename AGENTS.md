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
    pnpm typecheck   # tsc --noEmit in every workspace package
    pnpm build       # build every workspace package
    pnpm test        # vitest

All four must pass before you push or open a PR.
