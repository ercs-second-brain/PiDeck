# State commands: status, kanban, sessions, workers, pulls, diff

Read-only commands for project and daemon state. All accept `--json`; JSON shapes are the shared zod schemas in `packages/shared` (`Settings`, `KanbanBoard`, `Session`, `Worker`, `PullRequest`, `PullRequestDiff`).

## agentskiss status

Show daemon status — verify the daemon is up before other commands.

```
agentskiss status [--json]
```

## agentskiss kanban

Read a project's kanban board: columns `backlog`, `in_progress`, `in_review`, `done` (workflow order), each with its cards.

```
agentskiss kanban --project <id> [--json]
```

→ `GET /api/projects/:projectId/kanban`

## agentskiss sessions

List a project's agent sessions (orchestrator and workers). Use this to find session ids for `agentskiss send`.

```
agentskiss sessions --project <id> [--json]
```

→ `GET /api/projects/:projectId/sessions`

## agentskiss workers

List a project's workers with lifecycle statuses: `spawning`, `running`, `awaiting_ci`, `fixing_ci`, `addressing_review`, `done`, `failed`, `stopped`. Each worker carries its `issueNumber` and (once opened) `prNumber`.

```
agentskiss workers --project <id> [--json]
```

→ `GET /api/projects/:projectId/workers`

## agentskiss pulls

List a project's PRs with `ciStatus` (`pending | running | success | failure | unknown`) and `reviewState` (`none | pending | approved | changes_requested`). Primary input for the `ci-status` and `review-comments` skills.

```
agentskiss pulls --project <id> [--json]
```

→ `GET /api/projects/:projectId/pulls`

## agentskiss diff

Read one PR's full unified diff plus per-file stats.

```
agentskiss diff --project <id> <pr-number>
```

→ `GET /api/projects/:projectId/pulls/:prNumber/diff`

## Examples

```bash
# Board overview before spawning
agentskiss kanban --project agentskiss --json

# Find the worker that owns issue 5 and message it
agentskiss workers --project agentskiss --json
agentskiss send --session <worker-session-id> --message "..."
```
