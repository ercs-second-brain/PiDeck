# agentskiss agent integration

Prompts and pi skills for agentskiss orchestration. The daemon loads `prompts/` into orchestrator/worker pi sessions at session start; the installer symlinks `skills/` into pi's skill location (`~/.pi/agent/skills/`); the `agentskiss` CLI the skills call is implemented in `apps/daemon/src/cli`.

## Layout

```
agent/
├── README.md                  # this file — skill↔daemon interface contract
├── prompts/
│   ├── orchestrator.md        # orchestrator system prompt (daemon assembles)
│   └── worker.md              # worker system prompt (daemon assembles)
└── skills/                    # pi skill dirs (SKILL.md + optional commands/)
    ├── using-agentskiss/      # daemon CLI catalog (SKILL.md + commands/)
    ├── create-issue/          # file a GitHub issue via gh
    ├── spawn-worker/          # request a worker spawn via the daemon CLI
    ├── report-pr/             # worker self-report of an opened PR (issue #49)
    ├── ci-status/             # CI status lookup
    └── review-comments/       # review-comment retrieval
```

Skills follow pi's skill conventions (frontmatter with `name`/`description`, loaded on demand); see pi's `docs/skills.md`.

## Prompts

Ported from [agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) (`backend/internal/session_manager/prompt.go`) nearly verbatim, adapted to agentskiss tooling: `ao` CLI calls became `agentskiss` CLI calls, `AO_SESSION_ID` became `AGENTSKISS_SESSION_ID`, and PR-claiming (`ao session claim-pr`) was replaced by agentskiss's one-worker-per-issue ownership model. The orchestration discipline (coordination-only orchestrator, worker delegation, CI-fix loop, review-comment addressing, kanban state language, publishing scope, standing-instruction confidentiality) is unchanged.

`{{PLACEHOLDER}}` tokens are substituted by the daemon at session start (issue #12):

| Placeholder | Substituted with |
|---|---|
| `{{PROJECT_ID}}` | Project id (`Project.id`) |
| `{{PROJECT_NAME}}` | Project name (`Project.name`) |
| `{{PROJECT_REPO_URL}}` | `Project.repoUrl` |
| `{{PROJECT_DEFAULT_BRANCH}}` | `Project.defaultBranch` |
| `{{PROJECT_PATH}}` | Local checkout path of the project |
| `{{ORCHESTRATOR_SESSION_ID}}` | The project's orchestrator session id (worker prompt only; daemon omits that section when no orchestrator exists) |

Runtime environment: the daemon sets `AGENTSKISS_SESSION_ID` in every agent session so workers and docker container labels can reference their own session (worker prompt, "Docker Containers" section).

## Skill ↔ daemon interface

The skills shell out to two CLIs:

1. **`gh`** (GitHub CLI) for things GitHub serves directly and the daemon only observes: issue creation, per-check CI detail, review comment bodies. No daemon involvement; auth comes from onboarding.
2. **`agentskiss`** (the daemon CLI, implemented in issue #9) for daemon-owned state and actions. Every command invocation lives in exactly one place — a skill's SKILL.md or one `using-agentskiss/commands/*.md` page — so #9 can match names and flags.

### agentskiss CLI surface

Each row's REST mapping is from `packages/shared/src/rest.ts`. "Finalized in #9" rows are daemon actions with no REST endpoint yet; the flags below are the contract for #9 to implement.

| Command | Flags | Backing | Notes |
|---|---|---|---|
| `agentskiss status` | `--json` | Daemon liveness | Health check only |
| `agentskiss project get <id>` | `--json` | `GET /api/projects/:projectId` | Returns `Project` |
| `agentskiss project ls` | `--json` | `GET /api/projects` | Returns `Project[]` |
| `agentskiss kanban --project <id>` | `--json` | `GET /api/projects/:projectId/kanban` | Returns `KanbanBoard` |
| `agentskiss sessions --project <id>` | `--json` | `GET /api/projects/:projectId/sessions` | Returns `Session[]` |
| `agentskiss workers --project <id>` | `--json` | `GET /api/projects/:projectId/workers` | Returns `Worker[]` |
| `agentskiss pulls --project <id>` | `--json` | `GET /api/projects/:projectId/pulls` | Returns `PullRequest[]` (incl. `ciStatus`, `reviewState`) |
| `agentskiss diff --project <id> <pr>` | — | `GET /api/projects/:projectId/pulls/:prNumber/diff` | Returns `PullRequestDiff` |
| `agentskiss spawn` | `--project <id>`, `--issue <number>`, `--name <label ≤20>`, `--prompt <task>` | `POST /api/projects/:projectId/spawn` | Daemon action; rejects with 409 past the project's `workerConcurrency` cap; emits `worker.spawned` (`packages/shared/src/ws.ts`) |
| `agentskiss send` | `--session <id>`, `--message <text>` | `POST /api/sessions/:sessionId/send` | Delivers into the session's tmux pane (typed, then Enter) |
| `agentskiss report-pr <pr>` | — | `POST /api/sessions/report-pr` | Worker session self-reports its PR (resolved from its tmux pane context); explicit report wins over the title/branch heuristic, which stays as fallback (issue #49) |

`GET /api/status` (daemon liveness, the `status` backing), project mutation endpoints (`POST`/`PATCH`/`DELETE /api/projects...`), `POST /api/projects/:projectId/orchestrator` (start a project's orchestrator from the webapp terminals sidebar, issue #53), `GET`/`PUT /api/settings`, and `GET /api/gh-auth` (onboarding wizard) are webapp/owner operations — no skill invokes them.

### Contract consistency

- JSON output shapes are the zod schemas in `packages/shared/src/domain.ts` (`Project`, `Session`, `Worker`, `PullRequest`, `KanbanBoard`, `PullRequestDiff`); skills never assume fields outside those schemas.
- Status vocabularies used verbatim in prompts and skills: kanban columns `backlog`, `in_progress`, `in_review`, `done` (`KANBAN_COLUMNS`); worker statuses `spawning`, `running`, `awaiting_ci`, `fixing_ci`, `addressing_review`, `done`, `failed`, `stopped` (`workerStatusSchema`); CI `pending`, `running`, `success`, `failure`, `unknown` (`ciStatusSchema`); review `none`, `pending`, `approved`, `changes_requested` (`reviewStateSchema`).
- `packages/shared` is the source of truth; this directory consumes the contract conceptually and must not edit or duplicate it.

### Where each invocation lives

| Invocation | Canonical location |
|---|---|
| `gh issue create ...` | `skills/create-issue/SKILL.md` |
| `agentskiss spawn ...` | `skills/spawn-worker/SKILL.md` (reference doc: `skills/using-agentskiss/commands/spawn.md`) |
| `agentskiss pulls ...`, `agentskiss diff ...` | `skills/ci-status/SKILL.md` |
| `gh pr checks ...`, `gh run view ...`, `gh api .../pulls/<n>/comments`, `gh pr view --comments` | `skills/review-comments/SKILL.md` |
| all other `agentskiss` read commands | `skills/using-agentskiss/commands/state.md`, `commands/project.md` |
| `agentskiss send ...` | `skills/using-agentskiss/commands/send.md` |
| `agentskiss report-pr <pr>` | `skills/report-pr/SKILL.md` |

## Installer notes

- `install/lib/assets.sh` symlinks each `agent/<kind>/<name>` (kinds: `skills`, `extensions`, `commands`, `prompt-templates`, `themes`) into `~/.pi/agent/<kind>/`; each skill subdirectory is self-contained.
- `agent/prompts/*` are daemon assets, not skills — they stay in the checkout; the daemon resolves them at runtime (repo walk-up from its own module path, or `AGENTSKISS_AGENT_DIR` when set) and renders them per project/session.
- Runtime prerequisites for the skills: `gh` (authed during onboarding) and `agentskiss` on `PATH` (the install shim forwards these commands to the daemon CLI).
