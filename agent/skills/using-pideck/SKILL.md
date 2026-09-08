---
name: using-pideck
description: "Catalog of the PiDeck daemon CLI: spawning workers, sending messages to sessions, inspecting projects, and reading board/session/PR state. Use when using the pideck CLI in a PiDeck-managed project."
trigger: "Using the pideck CLI: spawning workers, messaging sessions, inspecting projects, kanban, PRs, or daemon status."
---

# PiDeck CLI Catalog

`pideck` is a thin CLI over the local PiDeck daemon. The REST surface it wraps is defined in `packages/shared/src/rest.ts` — see `agent/README.md` for the authoritative command↔endpoint mapping.

| Command | What it does | When to use | Details |
|---|---|---|---|
| `pideck spawn` | Spawn a worker agent in a fresh git worktree | Starting a new task or issue | [commands/spawn.md](commands/spawn.md) |
| `pideck send` | Send a message to a running agent session | Correcting or directing a live agent | [commands/send.md](commands/send.md) |
| `pideck report-pr <pr>` | Report your PR to the daemon (worker panes only) | Right after opening a PR in a worker session | worker skill: `report-pr` |
| `pideck project` | Inspect registered projects | Looking up repo, branch, or settings | [commands/project.md](commands/project.md) |
| `pideck status` | Show daemon status | Verifying the daemon is up | [commands/state.md](commands/state.md) |
| `pideck kanban` | Read a project's kanban board | Checking card columns | [commands/state.md](commands/state.md) |
| `pideck sessions` | List sessions of a project | Finding session ids | [commands/state.md](commands/state.md) |
| `pideck workers` | List workers of a project | Checking worker statuses | [commands/state.md](commands/state.md) |
| `pideck pulls` | List a project's PRs with CI/review state | CI and review triage | [commands/state.md](commands/state.md) |
| `pideck diff` | Read a PR's full diff | Reviewing what a PR changes | [commands/state.md](commands/state.md) |

## Conventions

- Read commands accept `--json` for machine-readable output matching the shared zod schemas in `packages/shared`.
- `--project <id>` scopes a command to one project; project ids come from `pideck project get` / the webapp.
- `pideck --help` (or `pideck help`) prints the full command list; per-subcommand `-h` is not supported — each command's usage line is shown in its error output when flags are wrong.

## Task skills

The command catalog above is generic. Task-oriented orchestration skills build on it:

- `create-issue` — file a GitHub issue via `gh`.
- `spawn-worker` — request a worker spawn (pre-flight checks + invocation).
- `report-pr` — a worker session reports the PR it opened (`pideck report-pr`).
- `ci-status` — CI status lookup and CI-fix routing.
- `review-comments` — review-comment retrieval and addressing workflow.
- `review-pr` — the auto review agent's workflow: review a PR diff and post the GitHub review (issue #107).

Use [references to `packages/shared/src/rest.ts`] only when a request does not map clearly to a command above.
