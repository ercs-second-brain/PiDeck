---
name: spawn-worker
description: "Request a worker spawn through the pideck daemon CLI (pideck spawn), for an issue or a freeform task. Use when the user or orchestrator asks to start a worker, work an issue, or parallelize a task."
trigger: "Spawning or starting a PiDeck worker."
---

# Request a Worker Spawn

Spawns are the daemon's job: the CLI asks the daemon, the daemon creates the tmux session and git worktree and reports the worker. The one canonical invocation lives here so the CLI implementation and these skills stay in lockstep.

## The invocation

```bash
# Worker for an issue (preferred; daemon links worker → issue → kanban card)
pideck spawn --project {{PROJECT_ID}} --issue <issue-number> --name "<label>"

# Freeform worker with an explicit task
pideck spawn --project {{PROJECT_ID}} --name "<label>" --prompt "<clear worker task>"
```

Flags:

| Flag | Meaning | Required |
|---|---|---|
| `--project <id>` | Project id to spawn in | Yes |
| `--issue <number>` | GitHub issue number to associate (worker works that issue) | For issue work |
| `--name "<label>"` | Sidebar label, **20 characters or fewer** | Yes |
| `--prompt "<task>"` | Initial task prompt (freeform workers) | For freeform work |

## Before spawning

1. Inspect current state so you do not duplicate active sessions:
   `pideck workers --project {{PROJECT_ID}} --json` and `pideck sessions --project {{PROJECT_ID}} --json`.
2. Check the board: `pideck kanban --project {{PROJECT_ID}} --json` — an issue already `in_progress` with a live worker needs a message (`pideck send`), not a second worker.
3. Count the `--name` label yourself; it must be ≤ 20 characters. Shorten before executing.
4. Respect the project's `settings.workerConcurrency` (see `packages/shared/src/domain.ts`); do not spawn past the cap.

## After spawning

- Verify it came up: `pideck workers --project {{PROJECT_ID}} --json` — the new worker should appear with status `spawning` or `running`.
- The daemon emits a `worker.spawned` WebSocket event (see `packages/shared/src/ws.ts`); the kanban card moves to `in_progress`.

## Notes

- Never bypass the CLI by creating tmux sessions or running pi directly.
- Do not spawn workers for issues blocked via GitHub's native "blocked by" relationship links; the daemon's issue watcher enforces this for auto-spawn, and manual spawns should honor it too.
