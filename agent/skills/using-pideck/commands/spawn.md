# pideck spawn

Spawn a worker agent session in a registered project. The daemon creates the tmux session and git worktree; the worker runs the pi coding agent. (The orchestrator prompt and the methodology skills document the spawn workflow; this page documents the command itself.)

## Syntax

```
pideck spawn --project <id> [--issue <n> | --kind <agent-kind> [--question <q>]] --name <label> [--prompt <task>]
```

A spawn is either a **worker spawn** (`--issue` or `--prompt`) or an **agent-kind spawn** (`--kind`, see [agent-kind-spawn.md](agent-kind-spawn.md)) — never both.

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--project string` | Project id to spawn the worker in | Required |
| `--issue string` | GitHub issue number to associate with the worker | Worker spawns: `--issue` or `--prompt` |
| `--kind string` | Spawn an agent-kind session instead of a worker (see [agent-kind-spawn.md](agent-kind-spawn.md)) | Mutually exclusive with `--issue`/`--prompt` |
| `--question string` | The researcher's question (agent kinds with a `waitForInput` trigger) | Required for `--kind researcher`; forbidden for kinds that take no input |
| `--name string` | Display label shown in the kanban/sidebar (max 20 characters) | Required |
| `--prompt string` | Initial task prompt for the worker | Worker spawns: `--issue` or `--prompt` |

## Daemon behavior

- Backing endpoint: `POST /api/projects/:projectId/spawn`. The daemon creates the tmux session and git worktree, emits a `worker.spawned` event (`packages/shared/src/ws.ts`), and reports the worker via `GET /api/projects/:projectId/workers`.
- The new worker starts with status `spawning` (`packages/shared/src/domain.ts` → `workerStatusSchema`).
- Spawns are capped by the project's `settings.workerConcurrency`: past the cap the daemon rejects the spawn with 409 (the auto-spawn pipeline queues instead of rejecting).

## Examples

```bash
# Spawn a worker for issue 5
pideck spawn --project pideck --issue 5 --name "phase1-prompts"
```

```bash
# Spawn a freeform worker
pideck spawn --project pideck --name "triage-flaky-ci" --prompt "Research the flaky kanban test and fix it."
```
