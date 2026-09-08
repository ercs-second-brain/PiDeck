# PiDeck agent integration

Prompts and pi skills for PiDeck orchestration. The daemon loads `prompts/` into orchestrator/worker pi sessions at session start; the installer symlinks `skills/` into pi's skill location (`~/.pi/agent/skills/`); the `pideck` CLI the skills call is implemented in `apps/daemon/src/cli`.

## Layout

```
agent/
├── README.md                  # this file — skill↔daemon interface contract
├── prompts/
│   ├── orchestrator.md        # orchestrator system prompt (daemon assembles)
│   └── worker.md              # worker system prompt (daemon assembles)
└── skills/                    # pi skill dirs (SKILL.md + optional commands/)
    ├── using-pideck/      # daemon CLI catalog (SKILL.md + commands/)
    ├── create-issue/          # file a GitHub issue via gh
    ├── spawn-worker/          # request a worker spawn via the daemon CLI
    ├── report-pr/             # worker self-report of an opened PR (issue #49)
    ├── ci-status/             # CI status lookup
    ├── review-comments/       # review-comment retrieval
    └── review-pr/             # auto review agent: review a PR, post the GitHub review (issue #107)
```

Skills follow pi's skill conventions (frontmatter with `name`/`description`, loaded on demand); see pi's `docs/skills.md`.

## Prompts

Ported from [agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) (`backend/internal/session_manager/prompt.go`) nearly verbatim, adapted to PiDeck tooling: `ao` CLI calls became `pideck` CLI calls, `AO_SESSION_ID` became `PD_SESSION_ID`, and PR-claiming (`ao session claim-pr`) was replaced by PiDeck's one-worker-per-issue ownership model. The orchestration discipline (coordination-only orchestrator, worker delegation, CI-fix loop, review-comment addressing, kanban state language, publishing scope, standing-instruction confidentiality) is unchanged.

`{{PLACEHOLDER}}` tokens are substituted by the daemon at session start (issue #12):

| Placeholder | Substituted with |
|---|---|
| `{{PROJECT_ID}}` | Project id (`Project.id`) |
| `{{PROJECT_NAME}}` | Project name (`Project.name`) |
| `{{PROJECT_REPO_URL}}` | `Project.repoUrl` |
| `{{PROJECT_DEFAULT_BRANCH}}` | `Project.defaultBranch` |
| `{{PROJECT_PATH}}` | Local checkout path of the project |
| `{{ORCHESTRATOR_SESSION_ID}}` | The project's orchestrator session id (worker prompt only; daemon omits that section when no orchestrator exists) |

Runtime environment: the daemon sets `PD_SESSION_ID` in every agent session so workers and docker container labels can reference their own session (worker prompt, "Docker Containers" section).

## Skill ↔ daemon interface

The skills shell out to two CLIs:

1. **`gh`** (GitHub CLI) for things GitHub serves directly and the daemon only observes: issue creation, per-check CI detail, review comment bodies. No daemon involvement; auth comes from onboarding.
2. **`pideck`** (the daemon CLI, implemented in issue #9) for daemon-owned state and actions. Every command invocation lives in exactly one place — a skill's SKILL.md or one `using-pideck/commands/*.md` page — so #9 can match names and flags.

### pideck CLI surface

Each row's REST mapping is from `packages/shared/src/rest.ts`. "Finalized in #9" rows are daemon actions with no REST endpoint yet; the flags below are the contract for #9 to implement.

| Command | Flags | Backing | Notes |
|---|---|---|---|
| `pideck status` | `--json` | Daemon liveness | Health check only |
| `pideck project get <id>` | `--json` | `GET /api/projects/:projectId` | Returns `Project` |
| `pideck project ls` | `--json` | `GET /api/projects` | Returns `Project[]` |
| `pideck kanban --project <id>` | `--json` | `GET /api/projects/:projectId/kanban` | Returns `KanbanBoard` |
| `pideck sessions --project <id>` | `--json` | `GET /api/projects/:projectId/sessions` | Returns `Session[]` |
| `pideck workers --project <id>` | `--json` | `GET /api/projects/:projectId/workers` | Returns `Worker[]` |
| `pideck pulls --project <id>` | `--json` | `GET /api/projects/:projectId/pulls` | Returns `PullRequest[]` (incl. `ciStatus`, `reviewState`) |
| `pideck diff --project <id> <pr>` | — | `GET /api/projects/:projectId/pulls/:prNumber/diff` | Returns `PullRequestDiff` |
| `pideck spawn` | `--project <id>`, `--issue <number>`, `--name <label ≤20>`, `--prompt <task>` | `POST /api/projects/:projectId/spawn` | Daemon action; rejects with 409 past the project's `workerConcurrency` cap; emits `worker.spawned` (`packages/shared/src/ws.ts`). The initial `--prompt` is gated on pi auth readiness (issue #56): with no ready provider the worker holds at `spawning` (statusMessage names the fix) and the prompt is queued and delivered automatically once auth is ready |
| `pideck send` | `--session <id>`, `--message <text>` | `POST /api/sessions/:sessionId/send` | Delivers into the session's tmux pane (typed, then Enter) |
| `pideck report-pr <pr>` | — | `POST /api/sessions/report-pr` | Worker session self-reports its PR (resolved from its tmux pane context); explicit report wins over the title/branch heuristic, which stays as fallback (issue #49) |

`GET /api/status` (daemon liveness, the `status` backing), project mutation endpoints (`POST`/`PATCH`/`DELETE /api/projects...`), `POST /api/projects/:projectId/orchestrator` (start a project's orchestrator from the webapp terminals sidebar, issue #53), `GET`/`PUT /api/settings`, `GET /api/gh-auth` (onboarding wizard), `GET /api/update` (self-update check behind the webapp banner, issue #55), and `POST /api/update/apply` (click-to-update, gated on all workers idle — issue #76) are webapp/owner operations — no skill invokes them.

### Contract consistency

- JSON output shapes are the zod schemas in `packages/shared/src/domain.ts` (`Project`, `Session`, `Worker`, `PullRequest`, `KanbanBoard`, `PullRequestDiff`); skills never assume fields outside those schemas.
- Status vocabularies used verbatim in prompts and skills: kanban columns `backlog`, `in_progress`, `in_review`, `done` (`KANBAN_COLUMNS`); worker statuses `spawning`, `running`, `awaiting_ci`, `fixing_ci`, `addressing_review`, `done`, `failed`, `stopped` (`workerStatusSchema`); CI `pending`, `running`, `success`, `failure`, `unknown` (`ciStatusSchema`); review `none`, `pending`, `approved`, `changes_requested` (`reviewStateSchema`).
- `packages/shared` is the source of truth; this directory consumes the contract conceptually and must not edit or duplicate it.

### Where each invocation lives

| Invocation | Canonical location |
|---|---|
| `gh issue create ...` | `skills/create-issue/SKILL.md` |
| `pideck spawn ...` | `skills/spawn-worker/SKILL.md` (reference doc: `skills/using-pideck/commands/spawn.md`) |
| `pideck pulls ...`, `pideck diff ...` | `skills/ci-status/SKILL.md` |
| `gh pr checks ...`, `gh run view ...`, `gh api .../pulls/<n>/comments`, `gh pr view --comments` | `skills/review-comments/SKILL.md` |
| `gh pr diff ...`, `gh pr review ...`, `gh api .../pulls/<n>/reviews` | `skills/review-pr/SKILL.md` (auto review agent, issue #107) |
| all other `pideck` read commands | `skills/using-pideck/commands/state.md`, `commands/project.md` |
| `pideck send ...` | `skills/using-pideck/commands/send.md` |
| `pideck report-pr <pr>` | `skills/report-pr/SKILL.md` |

## Installer notes

- `install/lib/assets.sh` symlinks each `agent/<kind>/<name>` (kinds: `skills`, `extensions`, `commands`, `prompt-templates`, `themes`) into `~/.pi/agent/<kind>/`; each skill subdirectory is self-contained.
- `agent/prompts/*` are daemon assets, not skills — they stay in the checkout; the daemon resolves them at runtime (repo walk-up from its own module path, or `PD_AGENT_DIR` when set) and renders them per project/session.
- Runtime prerequisites for the skills: `gh` (authed during onboarding) and `pideck` on `PATH` (the install shim forwards these commands to the daemon CLI).
