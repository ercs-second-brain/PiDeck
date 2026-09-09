# Preset-prompt agent kinds (issues #297, #300, #302)

A generic mechanism for spawning PiDeck agents with a **pre-baked persona
prompt** and a **fixed report route** — instead of three bespoke code paths
(researcher, devex-audit, kiss-audit), one kind registry drives all of
them. Adding a fourth kind later is an enum entry, a persona file, a
registry row, and one `AGENT_KIND_INFO` metadata row (issue #324: labels,
⋯-menu text, and input rules are data-driven from shared — daemon and web
alike). Nothing else; type-checking catches misses.

This doc is the scaffold contract: the implementing worker builds the
plumbing (spawn/registration/sidebar/CLI) on top of it after #290 merges.

## The three kinds

| Kind | Purpose | Read-only | Report route | Spawn surface |
|---|---|---|---|---|
| `researcher` | Take a question, return an accurate report grounded in codebase facts (files + lines cited) | yes | back to the **calling session** (any role); the caller waits | any agent, via spawn |
| `devex-audit` | Mine prior pi sessions for friction / time / money sinks; count, summarize, rank fixes (credentials REDACTED) | yes | the **project orchestrator** | project ⋯ context menu, CLI |
| `kiss-audit` | KISS methodology audit — 7 dimensions + repo extras, evidence-backed findings, TOP-5, net line delta | yes | the **project orchestrator** | project ⋯ context menu, CLI |

All three are read-only by design: findings and reports, never edits,
commits, or PRs.

## 1. Kind registration

- `packages/shared`: new `agentKindSchema = z.enum(["researcher", "devex-audit", "kiss-audit"])`.
  This is the agent-kind contract; it is distinct from the existing
  `workerKindSchema` (`implementer`/`reviewer`), which keeps its meaning
  for PR ownership semantics. A spawn is either a worker (issue/PR-owned)
  or an agent-kind session (preset persona, report-routed).
- `apps/daemon/src/sessions/agent-kinds.ts` (new): the **kind registry** —
  the single table the spawn path reads:

  ```ts
  interface AgentKindSpec {
    /** Persona template file under agent/prompts/, rendered like worker prompts. */
    personaFile: string;
    /** Whether the spawn occupies a worker-like workspace (concurrency-capped). */
    workerLike: boolean;
    /** Whether the pane launches with the write tools excluded. */
    readOnly: boolean;
  }

  const AGENT_KINDS: Record<AgentKind, AgentKindSpec> = { ... };
  ```

  The report route (`AGENT_KIND_REPORT_TARGET`) and the presentation
  metadata (sidebar label, ⋯-menu text, `takesInput` input rules —
  `AGENT_KIND_INFO`, issue #324) live beside the enum in `packages/shared`,
  so daemon and web render from one source.

  Adding a kind = enum entry + persona file + registry row + one
  `AGENT_KIND_INFO` row. Nothing else.

## 2. Persona files

One file per kind: `agent/prompts/<kind>.md`, same `{{PLACEHOLDER}}`
rendering as the existing personas (see
`apps/daemon/src/orchestrator/prompt.ts`):

| Placeholder | Availability |
|---|---|
| `{{PROJECT_ID}}`, `{{PROJECT_NAME}}`, `{{PROJECT_REPO_URL}}`, `{{PROJECT_DEFAULT_BRANCH}}`, `{{PROJECT_PATH}}` | all project-scoped personas |
| `{{ORCHESTRATOR_SESSION_ID}}` | kinds with `reportTarget: "project-orchestrator"` |
| `{{PARENT_SESSION_ID}}` | kinds with `reportTarget: "caller"` — **new**; the spawn path must stamp the calling session's registry id |

The persona file owns everything role-specific: methodology, report
format, redaction rules, read-only constraints. The spawn path owns
everything mechanical: which file, which parent, which report target.

## 3. Parent-of-any-role linkage

- Spawn options already carry `parentWorkerId` (review agents, #107).
  Generalize the semantics to **parent of any role**: the parent may be a
  global-agent, orchestrator, worker, or reviewer session — the registry
  records the parent session id unchanged, and sidebar nesting follows the
  same lineage grouping workers already use (#187/#249).
- Researcher sessions nest under their caller; audit sessions nest under
  the project orchestrator they report to (their parent is the orchestrator
  by construction when spawned from the ⋯ menu, and the spawning actor's
  session otherwise).
- `pideck sessions` renders the kind label and the nesting for free once
  the registry linkage exists.

## 4. Report routing

- `reportTarget: "caller"` (researcher): the spawn API resolves
  **synchronously-or-blocking** semantics for the caller — the calling
  agent's flow waits for the report. Plumbing: the spawn response returns
  the researcher's session id immediately (so the caller can poll or be
  notified), and the researcher persona's contract is to deliver the
  report with `pideck send --session {{PARENT_SESSION_ID}}`. The caller's
  persona guidance: do not act on assumptions while waiting; treat the
  report as the answer.
- `reportTarget: "project-orchestrator"` (audits): the persona's final
  action is `pideck send --session {{ORCHESTRATOR_SESSION_ID}}` with the
  full report. The orchestrator decides what becomes issues/tasks
  (bug-bash-style triage is its normal workflow); the user is not the
  direct recipient. No auto-triage automation.

## 5. Spawn surfaces

- CLI parity: `pideck spawn --project <id> --kind researcher --name "<label>"`
  (freeform agent kinds never require `--prompt`; the persona is the
  prompt). `pideck sessions` / `workers` show the kind.
- Sidebar ⋯ menu (web): a "Spawn agent" section listing the project-scoped
  kinds (`devex-audit`, `kiss-audit`). Researcher is agent-facing and has
  no menu entry.
- Worker-concurrency settings apply to audit kinds (they are worker-like:
  real workspace, own session); researcher sessions are cheap and
  exempt.

## 6. Sequencing / out of scope

- Plumbing lands after #290 (bootstrap/handlers lane) merges; sidebar UI
  coordinates with the #294 sweep.
- Out of scope here: write capabilities for any kind; general-purpose
  subagent abstraction beyond the kind registry; auto-triage.

## 7. Kind-id migration: `investigator` → `researcher` (issue #335)

The researcher kind was shipped as `investigator` (label `investigate`,
persona file `agent/prompts/investigator.md`). Issue #335 renamed the kind
id, the sidebar label, and the persona file everywhere — schema, registry,
docs, UI strings, CLI, tests — with no alias in the enum (a permanent alias
would keep the legacy vocabulary alive in every switch).

**Session compatibility.** Persisted state references the kind id in two
places, and a naive rename would make the loader drop that state:

- `sessions.json` — `Session.agentKind`. The registry loader
  (`apps/daemon/src/sessions/registry.ts`, `migrateSessionKind`) rewrites
  the legacy id to `researcher` during validation, before the session
  schema runs. The record therefore keeps rendering, nesting, and
  terminating exactly as before, and the next save persists the new id.
- `agent-assets.json` (issue #315) — a stored prompt override keyed by the
  persona and skills' applied-persona lists. The `AgentAssetsStore` loader
  (`migrateLegacyPersonas`) rewrites both on load, so user-owned edits
  survive the rename.

Both migrations are one-time in effect (the next save writes the new id)
and are the ONLY places in the codebase that still mention the legacy id —
everything else speaks `researcher`. No tmux session names, spawn
commands, or pane state embed the kind id, so no live panes are affected;
a relaunched legacy session re-derives its launch line from the migrated
registry record (persona file `agent/prompts/researcher.md`).
