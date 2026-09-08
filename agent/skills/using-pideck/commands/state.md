# State commands: status, kanban, sessions, workers, pulls, diff

Read-only commands for project and daemon state. All accept `--json`; JSON shapes are the shared zod schemas in `packages/shared` (`KanbanBoard`, `Session`, `Worker`, `PullRequest`, `PullRequestDiff`).

## pideck status

Show daemon status — verify the daemon is up before other commands.

```
pideck status [--json]
```

## pideck kanban

Read a project's kanban board: columns `backlog`, `in_progress`, `in_review`, `done` (workflow order), each with its cards.

```
pideck kanban --project <id> [--json]
```

→ `GET /api/projects/:projectId/kanban`

## pideck sessions

List a project's agent sessions (orchestrator and workers). Use this to find session ids for `pideck send`.

```
pideck sessions --project <id> [--json]
```

→ `GET /api/projects/:projectId/sessions`

## pideck workers

List a project's workers with lifecycle statuses: `spawning`, `running`, `awaiting_ci`, `fixing_ci`, `addressing_review`, `done`, `failed`, `stopped`. Each worker carries its `issueNumber` and (once opened) `prNumber`.

```
pideck workers --project <id> [--json]
```

→ `GET /api/projects/:projectId/workers`

## pideck pulls

List a project's PRs with `ciStatus` (`pending | running | success | failure | unknown`) and `reviewState` (`none | pending | approved | changes_requested`). Primary input for the `ci-status` and `review-comments` skills.

```
pideck pulls --project <id> [--json]
```

→ `GET /api/projects/:projectId/pulls`

## pideck diff

Read one PR's full unified diff plus per-file stats.

```
pideck diff --project <id> <pr-number>
```

→ `GET /api/projects/:projectId/pulls/:prNumber/diff`

## Examples

```bash
# Board overview before spawning
pideck kanban --project pideck --json

# Find the worker that owns issue 5 and message it
pideck workers --project pideck --json
pideck send --session <worker-session-id> --message "..."
```
