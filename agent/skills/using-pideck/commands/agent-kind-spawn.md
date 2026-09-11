# pideck spawn --kind: agent-kind sessions

Spawn a preset-prompt, read-only agent-kind session (docs/agent-kinds.md) instead of a worker: the kind fixes the persona and the report route. Agent kinds never take `--issue` or `--prompt` — the persona is the prompt. Kind rules (existence, trigger, report target) resolve against the daemon's kind registry, so user-defined kinds spawn with the same syntax.

## Syntax

```
pideck spawn --project <id> --kind <agent-kind> [--question <question>] --name <label>
```

(The full spawn usage — worker and kind forms — is on [spawn.md](spawn.md).)

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--project string` | Project id to spawn the session in | Required |
| `--kind string` | The agent-kind id (shipped kinds below; user-defined kinds resolve from the daemon's registry — an unknown kind errors with the valid list) | Required for a kind spawn |
| `--question string` | The kind's input, when its trigger is `waitForInput` (e.g. the researcher's question) | Required for `waitForInput` kinds; forbidden otherwise (the kind takes no input) |
| `--name string` | Display label shown in the kanban/sidebar (max 20 characters) | Required |

## Shipped kinds

| Kind | Trigger | Report route |
|---|---|---|
| `--kind researcher` | `waitForInput` — needs `--question "<q>"`; read-only; one question per session | calling session (the spawner waits for the report) |
| `--kind devex-audit` | `auto` — starts the audit on spawn; read-only | project orchestrator |
| `--kind kiss-audit` | `auto` — starts the audit on spawn; read-only | project orchestrator |

Kind rules the CLI enforces (errors otherwise):

- `--kind` cannot be combined with `--issue` or `--prompt`.
- A `waitForInput` kind needs `--question "<q>"`; kinds that take no input reject `--question`.
- Unknown kinds fail with the daemon registry's valid list — user-defined kinds spawn identically to the shipped ones.

## Examples

```bash
# Ask a researcher a codebase question; the report returns to your session
pideck spawn --project pideck --kind researcher --question "Why does the PR tracker drop stacked PRs?" --name "stacked-pr-q"

# Audits start on spawn and report to the project orchestrator — no --question
pideck spawn --project pideck --kind kiss-audit --name "kiss-audit-board"
```

## Daemon behavior

- Backing endpoint: `POST /api/projects/:projectId/spawn` with `kind` in the body — the same endpoint a worker spawn uses (the body shape selects the path). The daemon stamps the calling session as `parentSessionId` and returns the session record (agent-kind sessions are not workers). The kind's spec (persona, trigger, report target, `readOnly`) comes from `GET /api/agent-kinds`.
- The session's pane boots the kind's persona; a `researcher` waits for the `--question` typed with the spawn, then reports back to the calling session via `pideck send`.