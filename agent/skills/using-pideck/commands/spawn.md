# pideck spawn

Spawn a worker agent session in a registered project. The daemon creates the tmux session and git worktree; the worker runs the pi coding agent. This is the same invocation documented in the `spawn-worker` skill — that skill is the canonical home for the spawn call; this page documents the command itself.

## Syntax

```
pideck spawn [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--project string` | Project id to spawn the worker in | Required |
| `--issue string` | GitHub issue number to associate with the worker | - |
| `--name string` | Display label shown in the kanban/sidebar (max 20 characters) | Required |
| `--prompt string` | Initial task prompt for the worker | - |

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
pideck spawn --project pideck --name "triage-flaky-ci" --prompt "Investigate the flaky kanban test and fix it."
```
