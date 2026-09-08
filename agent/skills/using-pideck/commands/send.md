# pideck send

Send a message to a running agent session. Use this to correct or direct a live agent mid-stream without killing and respawning it — this is how orchestrators route CI failures and review findings to workers, and how workers escalate blockers to the orchestrator.

## Syntax

```
pideck send [flags]
```

## Flags

| Flag | Meaning | Default / Required |
|---|---|---|
| `--session string` | Session id (from `pideck sessions`) | Required |
| `--message string` | Message body | Required |

## Daemon behavior

- Backing endpoint: `POST /api/sessions/:sessionId/send` (`{ message }` body). Delivery goes into the session's tmux pane so the agent sees the message in its conversation.
- Session ids come from `pideck sessions --project <id> --json` (`packages/shared/src/domain.ts` → `Session`).

## Examples

```bash
# Route a CI failure to the worker that owns the PR
pideck send --session ask-3 --message "CI on PR #12 is red: typecheck fails in packages/shared. Fix and push."
```

```bash
# Worker escalates a decision to the orchestrator
pideck send --session ask-orchestrator --message "Blocked: issue says to edit packages/shared but another worker owns it. How to proceed?"
```
