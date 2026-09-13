# PiDeck

PiDeck is a self-hosted, single-user orchestration layer around the
[pi coding agent](https://github.com/badlogic/pi-mono): one daemon on your
machine, one web UI with browser terminals, four agent personas, and GitHub
as the only control plane. Issues are the work queue, assignment is the
trigger, comments are the steering channel, PRs and reviews are the state.
PiDeck is plumbing; pi is the agent.

The loop:

1. You talk to the project orchestrator; it files GitHub issues.
2. Assigning an issue spawns a worker on `pideck/issue-<n>`; it opens a PR.
3. When CI is green, a reviewer (the required second GitHub account) reviews.
4. Changes requested → the same worker fixes → the same reviewer re-reviews.
5. Approved + green → the orchestrator does an alignment check.
6. Merge (auto or on your say-so) closes the issue and unblocks dependents.

## Quick start

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/PiDeck/main/install/bootstrap.sh | sh
```

The bootstrap installs user-level dependencies (git, Node 22, pnpm, gh, pi),
builds the daemon and webapp, registers a persistent service, and runs guided
onboarding. `pideck addr` prints the webapp URL.

## Docs

- [docs/SPEC.md](docs/SPEC.md) — the spec of record
- [docs/DECISIONS.md](docs/DECISIONS.md) — why each spec decision was made
- [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) — the PiDeck-vs-pi line
- [docs/DESIGN.md](docs/DESIGN.md) — web UI design: tokens, terminal config, layout, primitives

## Testing

```sh
pnpm test
```

runs the whole suite, including the in-process loop test (`apps/daemon/src/e2e/`)
that boots the real reconciler against the fake gh (`tools/fake-gh/`) and walks
the loop end to end without GitHub or real agents. `pnpm lint`, `pnpm build`,
and `pnpm typecheck` must pass too — see `AGENTS.md`.

`pnpm e2e` runs the live loop once against real GitHub: it builds, pushes
`tools/e2e/fixture/` to a private throwaway repo, registers it in a throwaway
daemon, and asserts the scenario on GitHub facts and `/api/sessions` before
deleting the repo (unless `--keep`; other legs: `--scenario blocked|restart|rereview` —
`rereview` walks the post-approval loop: the reviewer approves with an inline comment,
the worker addresses it and pushes, the reviewer re-reviews the new head, then merge).
It needs the primary `gh` auth and the review account's PAT in
`PD_E2E_REVIEW_TOKEN`, so like the gallery it is a pre-merge check, not CI.

`pnpm ui-gallery` boots the real daemon against the fake gh and a fake tmux,
drives headless Playwright through every route at desktop and mobile widths,
and writes a labelled screenshot grid to `runs/ui/<timestamp>/` — read it
against `docs/DESIGN.md` before opening any web PR
(see `tools/ui-gallery/README.md`; not part of CI).
