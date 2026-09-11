# pideck assign

Assign a GitHub issue to the daemon's gh account. Assignment **auto-triggers a worker** (assignment-driven spawning): the daemon's GitHub watcher sees the `issue.assigned` transition and the issue pipeline spawns a worker for the issue — the assign command itself never spawns one. This is the ONE way agents trigger a worker for an existing issue; do not spawn workers for existing issues yourself.

## Syntax

```
pideck assign --project <id> --issue <n>
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--project string` | Project id the issue belongs to | Required |
| `--issue string` | GitHub issue number to assign | Required (positive number) |

## Daemon behavior

- Backing endpoint: `POST /api/projects/:projectId/assign`.
- The assignee is the daemon's own gh account (its authenticated `gh` login — the same account the watcher polls with).
- **Already assigned?** GitHub only fires `issue.assigned` on a transition, so when the gh account is already assigned the daemon first unassigns it and then re-assigns — the re-assignment re-triggers the worker. The command output says which path happened (`assigned` vs `re-assigned ... re-trigger`).
- The route fails (502) when the issue number cannot be fetched (unknown number, gh failure), and 400 when the number is a pull request.
- Spawning for the issue stays daemon-owned: do not follow an assign with a `pideck spawn --issue` for the same issue — that would duplicate work.

## Examples

```bash
# Trigger a worker for issue 5
pideck assign --project pideck --issue 5
```

```bash
# Re-trigger: the account was already assigned, so the daemon
# unassigns and re-assigns to fire a fresh worker
pideck assign --project pideck --issue 5
```

Use `pideck spawn` only for freeform (`--prompt`) work, lane-carrying follow-ons, and `--kind` agent-kind sessions.
