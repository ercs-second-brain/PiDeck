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
3. When CI is green, a reviewer (second GitHub account) reviews.
4. Changes requested → the same worker fixes → the same reviewer re-reviews.
5. Approved + green → the orchestrator does an alignment check.
6. Merge (auto or on your say-so) closes the issue and unblocks dependents.

The repo is being rebuilt from the spec; the v1 implementation was removed
entirely (no migration, no backwards compatibility).

Docs:

- [docs/SPEC.md](docs/SPEC.md) — the spec of record
- [docs/DECISIONS.md](docs/DECISIONS.md) — why each spec decision was made
- [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) — the PiDeck-vs-pi line
- [docs/DESIGN.md](docs/DESIGN.md) — web UI design: tokens, terminal config, layout, primitives