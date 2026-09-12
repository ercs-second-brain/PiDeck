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
