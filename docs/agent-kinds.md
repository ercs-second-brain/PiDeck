# Preset-prompt agent kinds (issues #297, #300, #302)

A generic mechanism for spawning PiDeck agents with a **pre-baked persona
prompt** and a **fixed report route** — instead of three bespoke code paths
(investigator, devex-audit, kiss-audit), one kind registry drives all of
them. Adding a fourth kind later is an enum entry, a persona file, and a
registry row.

This doc is the scaffold contract: the implementing worker builds the
plumbing (spawn/registration/sidebar/CLI) on top of it after #290 merges.

## The three kinds

| Kind | Purpose | Read-only | Report route | Spawn surface |
|---|---|---|---|---|
| `investigator` | Take a question, return an accurate report grounded in codebase facts (files + lines cited) | yes | back to the **calling session** (any role); the caller waits | any agent, via spawn |
| `devex-audit` | Mine prior pi sessions for friction / time / money sinks; count, summarize, rank fixes (credentials REDACTED) | yes | the **project orchestrator** | project ⋯ context menu, CLI |
| `kiss-audit` | KISS methodology audit — 7 dimensions + repo extras, evidence-backed findings, TOP-5, net line delta | yes | the **project orchestrator** | project ⋯ context menu, CLI |

All three are read-only by design: findings and reports, never edits,
commits, or PRs.

## 1. Kind registration

- `packages/shared`: new `agentKindSchema = z.enum(["investigator", "devex-audit", "kiss-audit"])`.
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
    /** Who receives the final report. */
    reportTarget: "caller" | "project-orchestrator";
    /** Sidebar label prefix (short, e.g. "◇ investigate"). */
    label: string;
  }

  const AGENT_KINDS: Record<AgentKind, AgentKindSpec> = { ... };
  ```

  Adding a kind = enum entry + persona file + registry row. Nothing else.

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
- Investigator sessions nest under their caller; audit sessions nest under
  the project orchestrator they report to (their parent is the orchestrator
  by construction when spawned from the ⋯ menu, and the spawning actor's
  session otherwise).
- `pideck sessions` renders the kind label and the nesting for free once
  the registry linkage exists.

## 4. Report routing

- `reportTarget: "caller"` (investigator): the spawn API resolves
  **synchronously-or-blocking** semantics for the caller — the calling
  agent's flow waits for the report. Plumbing: the spawn response returns
  the investigator's session id immediately (so the caller can poll or be
  notified), and the investigator persona's contract is to deliver the
  report with `pideck send --session {{PARENT_SESSION_ID}}`. The caller's
  persona guidance: do not act on assumptions while waiting; treat the
  report as the answer.
- `reportTarget: "project-orchestrator"` (audits): the persona's final
  action is `pideck send --session {{ORCHESTRATOR_SESSION_ID}}` with the
  full report. The orchestrator decides what becomes issues/tasks
  (bug-bash-style triage is its normal workflow); the user is not the
  direct recipient. No auto-triage automation.

## 5. Spawn surfaces

- CLI parity: `pideck spawn --project <id> --kind investigator --name "<label>"`
  (freeform agent kinds never require `--prompt`; the persona is the
  prompt). `pideck sessions` / `workers` show the kind.
- Sidebar ⋯ menu (web): a "Spawn agent" section listing the project-scoped
  kinds (`devex-audit`, `kiss-audit`). Investigator is agent-facing and has
  no menu entry.
- Worker-concurrency settings apply to audit kinds (they are worker-like:
  real workspace, own session); investigator sessions are cheap and
  exempt.

## 6. Sequencing / out of scope

- Plumbing lands after #290 (bootstrap/handlers lane) merges; sidebar UI
  coordinates with the #294 sweep.
- Out of scope here: write capabilities for any kind; general-purpose
  subagent abstraction beyond the kind registry; auto-triage.
