# PiDeck agent integration

Prompts and pi skills for PiDeck orchestration. The daemon loads `prompts/` into orchestrator/worker pi sessions at session start; the installer symlinks `skills/` into pi's skill location (`~/.pi/agent/skills/`); the `pideck` CLI the skills call is implemented in `apps/daemon/src/cli`.

Scope note: these prompts and skills are integration-level only — how agents talk to PiDeck. Capability customization (tools, skills, extensions) is a pi-level, user-owned choice; see [docs/PHILOSOPHY.md](../docs/PHILOSOPHY.md).

## Per-persona overrides & skills (issue #315)

Everything in this directory is the **shipped default**. PiDeck users can
override and extend it per persona, without touching the checkout, from the
webapp's "Prompts & skills" editor (sidebar, above Settings) backed by
`AgentAssetsStore` (`apps/daemon/src/api/agent-assets.ts`):

- **Prompt overrides** — one optional slot per persona (`global-agent`,
  `orchestrator`, `worker`, `researcher`, `devex-audit`, `kiss-audit`). A
  stored override replaces this file's content as the boot-prompt template;
  `{{PLACEHOLDER}}` rendering works the same, and this file stays the
  fallback. For orchestrator/global-agent/kind personas the daemon applies
  the override at boot/relaunch; for the worker persona it rides the recorded
  spawn command (`pi --append-system-prompt …`, no override = plain `pi`).
- **Per-persona skills** — user-created single-file pi skills applied to any
  set of personas, deployed under `<stateDir>/agent-assets/skills/<id>.md`
  and surfaced via pi's `--skill <file>` on every newly spawned pane of an
  applied persona. Shipped skills are enforced at launch time (issue
  #356): PiDeck-launched panes run pi with `--no-skills`, so the
  installer's global `~/.pi/agent/skills/` symlinks cannot leak a skill
  into a pane whose persona did not select it — the per-persona assignment
  is the single source of truth for what a pane loads.

Both are stored in the daemon state dir (`<stateDir>/agent-assets.json`) —
user-owned and update-safe. PiDeck stays unopinionated about the content
(docs/PHILOSOPHY.md): it is the editor/deployer of these user assets, nothing more.

## Layout

```
agent/
├── README.md                  # this file — skill↔daemon interface contract
├── prompts/
│   ├── orchestrator.md        # orchestrator system prompt (daemon assembles)
│   ├── global-agent.md        # workspace-level global agent prompt (daemon assembles)
│   └── worker.md              # worker system prompt (daemon assembles)
└── skills/                    # pi skill dirs (SKILL.md)
    ├── using-pideck/          # the pideck CLI catalog (SKILL.md + commands/) — every-persona default, issue #463
    ├── bash-triage/           # findings → issues → worker batch (orchestrator default, issue #338)
    ├── concept-brief/         # raw idea → one-page verbatim brief (orchestrator default, issue #338)
    ├── prd/                   # interview → one-page PRD (orchestrator default, issue #338)
    └── spec-to-issues/        # brief + PRD → phased issue graph (orchestrator default, issue #338)
```

Skills follow pi's skill conventions (frontmatter with `name`/`description`, loaded on demand); see pi's `docs/skills.md`.

### Shipped defaults (issue #338, extended by issue #463)

`bash-triage`, `concept-brief`, `prd`, and `spec-to-issues` are the shipped **orchestrator-default** workflow skills, and `using-pideck` — the `pideck` CLI catalog (SKILL.md + `commands/{agent-kind-spawn,project,send,spawn,state}.md`) — is the shipped **every-persona** skill: it documents the deterministic daemon CLI the whole design depends on, so it ships applied to all six personas out of the box. All are registered in `SHIPPED_DEFAULT_SKILLS` (`packages/shared/src/domain.ts`), typed against the canonical `PERSONAS` vocabulary and the `agentSkillIdSchema` id contract from #315. They are not hardcoded always-on: the daemon's agent-assets store seeds the table into its skills list (issue #351 F2 — the shipped `agent/skills/<name>/SKILL.md` content, deployed and applied like any stored skill; the seeding re-runs on schema bumps so newly shipped entries reach existing state dirs, issue #463), and afterwards every entry is an ordinary, user-owned row in the agent-assets surface (#315): per-persona configurable (turn-off-able, re-appliable to other personas), editable, and deletable — a delete sticks (deletions of shipped-default ids are recorded, so a later seeding never resurrects them, issue #463). User-authored skills deploy per persona via the same surface. Removals are table edits — reversible — never content deletions.

### Launch-time skill enforcement (issue #356)

Every PiDeck-launched pi pane (orchestrator, global agent, agent kind, worker) runs with `--no-skills`: pi's global skill discovery — including the installer's `~/.pi/agent/skills/` symlinks of this very directory, which pi would auto-load in every session on the machine — is off, so a skill restricted to one persona in the settings can never appear loaded in another persona's pane. Panes receive explicit `--skill` args for exactly the store skills assigned to their persona (issue #439: no ride-every-pane `--skill` plumbing — skills reach panes only through the per-persona assignment, seeded by the shipped table; anything the `pideck`/`gh` CLI does deterministically still lives in daemon code or the CLI's own `--help`, and procedural text lives in the persona prompts, not skills). The shipped table must exactly cover `agent/skills/` (drift-guarded in `apps/daemon/src/agent/shipped-skills.test.ts`), so every skill loadable by a pane appears in the Prompts & Skills settings. The installer's global symlinks stay: they serve pi sessions the user starts outside PiDeck, which PiDeck does not manage.

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
| `{{WORKSPACE_PATH}}` | Daemon state dir root — the workspace spanning every project (global-agent prompt only, `agent/prompts/global-agent.md`) |
| `{{ORCHESTRATOR_SESSION_ID}}` | The project's orchestrator session id (worker prompt only; daemon omits that section when no orchestrator exists) |

Runtime environment: the daemon sets `PD_SESSION_ID` in every agent session so workers and docker container labels can reference their own session (worker prompt, "Docker Containers" section).

## Skill ↔ daemon interface

The skills shell out to two CLIs:

1. **`gh`** (GitHub CLI) for things GitHub serves directly and the daemon only observes: issue creation, per-check CI detail, review comment bodies. No daemon involvement; auth comes from onboarding.
2. **`pideck`** (the daemon CLI, implemented in issue #9) for daemon-owned state and actions. With the integration skills gone (issue #439), the CLI's own `--help` is the command documentation and the persona prompts carry the invocations agents actually need.

### pideck CLI surface

Each row's REST mapping is from `packages/shared/src/rest.ts`. "Finalized in #9" rows are daemon actions with no REST endpoint yet; the flags below are the contract for #9 to implement.

| Command | Flags | Backing | Notes |
|---|---|---|---|
| `pideck status` | `--json` | Daemon liveness | Health check only |
| `pideck project get <id>` | `--json` | `GET /api/projects/:projectId` | Returns `Project` |
| `pideck project ls` | `--json` | `GET /api/projects` | Returns `Project[]` |
| `pideck kanban --project <id>` | `--json` | `GET /api/projects/:projectId/kanban` | Returns `KanbanBoard` |
| `pideck sessions --project <id>` | `--json` | `GET /api/projects/:projectId/sessions` | Returns `Session[]`; agent-kind sessions carry `agentKind`, `parentSessionId`, and the `name` sidebar label (docs/agent-kinds.md) |
| `pideck workers --project <id>` | `--json` | `GET /api/projects/:projectId/workers` | Returns `Worker[]` |
| `pideck pulls --project <id>` | `--json` | `GET /api/projects/:projectId/pulls` | Returns `PullRequest[]` (incl. `ciStatus`, `reviewState`) |
| `pideck diff --project <id> <pr>` | — | `GET /api/projects/:projectId/pulls/:prNumber/diff` | Returns `PullRequestDiff` |
| `pideck spawn` | `--project <id>`, (`--issue <number>` \| `--kind <agent-kind> [--question <q>]`), `--name <label ≤20>`, `--prompt <task>` | `POST /api/projects/:projectId/spawn` | Daemon action; rejects with 409 past the project's `workerConcurrency` cap; emits `worker.spawned` (`packages/shared/src/ws.ts`). The initial `--prompt` is gated on pi auth readiness (issue #56): with no ready provider the worker holds at `spawning` (statusMessage names the fix) and the prompt is queued and delivered automatically once auth is ready. `--kind` spawns a preset-prompt agent-kind session (docs/agent-kinds.md): `researcher` requires `--question` and reports back to the calling session; `devex-audit`/`kiss-audit` report to the project orchestrator; agent kinds never take `--prompt`/`--issue` (the persona is the prompt); audit kinds additionally receive their auto-task on spawn (issue #329) — the researcher is task-less and waits for `--question` |
| `pideck send` | `--session <id>`, `--message <text>` | `POST /api/sessions/:sessionId/send` | Delivers into the session's tmux pane (typed, then Enter) |

`GET /api/status` (daemon liveness, the `status` backing), project mutation endpoints (`POST`/`PATCH`/`DELETE /api/projects...`), `POST /api/projects/:projectId/orchestrator` (start a project's orchestrator from the webapp terminals sidebar, issue #53), `GET`/`PUT /api/settings`, `GET /api/gh-auth` (onboarding wizard), `GET /api/update` (self-update check behind the webapp banner, issue #55), and `POST /api/update/apply` (click-to-update, gated on all workers idle — issue #76) are webapp/owner operations — no skill invokes them.

### Contract consistency

- JSON output shapes are the zod schemas in `packages/shared/src/domain.ts` (`Project`, `Session`, `Worker`, `PullRequest`, `KanbanBoard`, `PullRequestDiff`); skills never assume fields outside those schemas.
- Status vocabularies used verbatim in prompts and skills: kanban columns `backlog`, `in_progress`, `in_review`, `done` (`KANBAN_COLUMNS`); worker statuses `spawning`, `running`, `awaiting_ci`, `fixing_ci`, `addressing_review`, `done`, `failed`, `stopped` (`workerStatusSchema`); CI `pending`, `running`, `success`, `failure`, `unknown` (`ciStatusSchema`); review `none`, `pending`, `approved`, `changes_requested` (`reviewStateSchema`).
- `packages/shared` is the source of truth; this directory consumes the contract conceptually and must not edit or duplicate it.

### Where each invocation lives

Canonical locations are the `using-pideck` CLI catalog (issue #463), the persona prompts (`agent/prompts/`), the shipped methodology skills, and the CLIs' own docs:

| Invocation | Canonical location |
|---|---|
| `pideck spawn ...`, `pideck send ...`, `pideck pulls ...`, `pideck diff ...`, all other `pideck` read commands | `skills/using-pideck/SKILL.md` + `skills/using-pideck/commands/*.md` (reference: `pideck --help`) |
| `gh issue create ...`, `gh label create ...` | `skills/bash-triage/SKILL.md`, `skills/spec-to-issues/SKILL.md` (single invocations: `agent/prompts/orchestrator.md`) |
| `pideck spawn ...` (workflow framing) | `agent/prompts/orchestrator.md`, `skills/bash-triage/SKILL.md`, `skills/spec-to-issues/SKILL.md` |
| `gh pr checks ...`, `gh run view ...`, `gh api .../pulls/<n>/comments`, `gh pr view --comments` | `agent/prompts/orchestrator.md`, `skills/bash-triage/SKILL.md` |
| `gh pr diff ...`, `gh pr review ...`, `gh api .../pulls/<n>/reviews` | the daemon's generated review prompts (`apps/daemon/src/pipeline/prs/prompts.ts`) |
| PR→worker claiming | deterministic daemon code — `apps/daemon/src/pipeline/issue-refs.ts` (no worker self-report exists; issue #439) |

## Installer notes

- `install/lib/assets.sh` symlinks each `agent/<kind>/<name>` (kinds: `skills`, `extensions`, `commands`, `prompt-templates`, `themes`) into `~/.pi/agent/<kind>/`; each skill subdirectory is self-contained.
- `agent/prompts/*` are daemon assets, not skills — they stay in the checkout; the daemon resolves them at runtime (repo walk-up from its own module path, or `PD_AGENT_DIR` when set) and renders them per project/session.
- Runtime prerequisites for the skills: `gh` (authed during onboarding) and `pideck` on `PATH` (the install shim forwards these commands to the daemon CLI).
