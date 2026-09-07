---
name: using-agentskiss
description: "Catalog of the agentskiss daemon CLI: spawning workers, sending messages to sessions, inspecting projects, and reading board/session/PR state. Use when using the agentskiss CLI in an agentskiss-managed project."
trigger: "Using the agentskiss CLI: spawning workers, messaging sessions, inspecting projects, kanban, PRs, or daemon status."
---

# agentskiss CLI Catalog

`agentskiss` is a thin CLI over the local agentskiss daemon. The REST surface it wraps is defined in `packages/shared/src/rest.ts` — see `agent/README.md` for the authoritative command↔endpoint mapping.

| Command | What it does | When to use | Details |
|---|---|---|---|
| `agentskiss spawn` | Spawn a worker agent in a fresh git worktree | Starting a new task or issue | [commands/spawn.md](commands/spawn.md) |
| `agentskiss send` | Send a message to a running agent session | Correcting or directing a live agent | [commands/send.md](commands/send.md) |
| `agentskiss report-pr <pr>` | Report your PR to the daemon (worker panes only) | Right after opening a PR in a worker session | worker skill: `report-pr` |
| `agentskiss project` | Inspect registered projects | Looking up repo, branch, or settings | [commands/project.md](commands/project.md) |
| `agentskiss status` | Show daemon status | Verifying the daemon is up | [commands/state.md](commands/state.md) |
| `agentskiss kanban` | Read a project's kanban board | Checking card columns | [commands/state.md](commands/state.md) |
| `agentskiss sessions` | List sessions of a project | Finding session ids | [commands/state.md](commands/state.md) |
| `agentskiss workers` | List workers of a project | Checking worker statuses | [commands/state.md](commands/state.md) |
| `agentskiss pulls` | List a project's PRs with CI/review state | CI and review triage | [commands/state.md](commands/state.md) |
| `agentskiss diff` | Read a PR's full diff | Reviewing what a PR changes | [commands/state.md](commands/state.md) |

## Conventions

- Read commands accept `--json` for machine-readable output matching the shared zod schemas in `packages/shared`.
- `--project <id>` scopes a command to one project; project ids come from `agentskiss project get` / the webapp.
- `agentskiss --help` (or `agentskiss help`) prints the full command list; per-subcommand `-h` is not supported — each command's usage line is shown in its error output when flags are wrong.

## Task skills

The command catalog above is generic. Task-oriented orchestration skills build on it:

- `create-issue` — file a GitHub issue via `gh`.
- `spawn-worker` — request a worker spawn (pre-flight checks + invocation).
- `report-pr` — a worker session reports the PR it opened (`agentskiss report-pr`).
- `ci-status` — CI status lookup and CI-fix routing.
- `review-comments` — review-comment retrieval and addressing workflow.

Use [references to `packages/shared/src/rest.ts`] only when a request does not map clearly to a command above.
