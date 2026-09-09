# Agent-kind registry v2 (issues #297, #300, #302, #330)

A generic mechanism for spawning PiDeck agents with a **pre-baked persona
prompt** and a **fixed report route** — one kind registry drives all of
them. Registry v2 (issue #330) opens the registry: the three built-ins
(researcher, devex-audit, kiss-audit) ship **as spec-v2 data** inside
`@pideck/shared`, and users define their own kinds at runtime through the
daemon's CRUD API, persisted under the daemon state dir (update-safe —
never in the PiDeck checkout). Nothing in the spawn/relaunch/reconcile/
ensure paths mentions a hardcoded kind name anymore.

## 1. The spec-v2 schema (the downstream contract)

Defined in `packages/shared/src/domain.ts`; this table is the contract
every consumer reads. Fields marked **user-settable** are writable via
the CRUD API; the rest are derived or fixed.

```ts
{
  name: string;          // kebab-case slug, 1–64 chars (agentKindIdSchema); immutable id
  label: string;         // 1–20 chars — sidebar/picker display name
  persona?: string;      // persona template content (see §3); REQUIRED for user kinds
  spawnableBy: Role[];   // which caller roles may spawn this kind (see §5); min 1
  callerWaits: boolean;  // caller semantics (see §6)
  readOnly: boolean;     // pane launches with write tools excluded (see §7)
  trigger: "auto" | "waitForInput";  // auto ⇔ taskTemplate present (schema-refined)
  taskTemplate?: string; // the work order typed after the persona boot (§6)
  reportTarget: "caller" | "orchestrator";  // the report route (§6)
  workerLike: boolean;   // occupies a worker-like workspace (concurrency-capped)
}
```

- `spawnableBy` roles: `"global"` | `"orchestrator"` | `"worker"` | `"reviewer"` —
  mapped from the *calling session's* role (§5).
- The schema-refined invariants (`agentKindSpecSchema`): `trigger: "auto"`
  requires a `taskTemplate`; `trigger: "waitForInput"` requires none. The
  create/update request schema additionally requires persona content
  (user kinds have no shipped-default file to fall back to).
- The kind id namespace is open (`AgentKind = string`) — sessions persist
  `agentKind` as the slug; the old closed enum is gone. Legacy persisted
  `investigator` ids are migrated to `researcher` on load (§8).

## 2. Shipped kinds as data; the registry

The three built-ins are data in `packages/shared/src/domain.ts`
(`SHIPPED_AGENT_KINDS`) — PiDeck dogfoods its own registry. Their persona
templates still ship as files under `agent/prompts/` (the spec's `persona`
field is omitted for them; see §3), and their specs are immutable
(§7). All three currently declare `spawnableBy` with all four roles
(back-compat with the pre-registry spawn surfaces).

Resolution lives in `apps/daemon/src/sessions/agent-kinds.ts`
(`AgentKindRegistry`): **user kinds first, then shipped** — a user kind
may shadow nothing shipped (the CRUD layer rejects name collisions), so
the ordering is about lookup cost, not precedence. `AGENT_KINDS`,
`AGENT_KIND_INFO`, and `agentKindInfo(kind)` in `@pideck/shared` remain
the presentation layer: shipped kinds contribute their rows, unknown/user
ids get a synthesized fallback (label = id, restrictive defaults) so the
web never crashes on a kind it hasn't seen.

Persistence (`apps/daemon/src/sessions/agent-kind-store.ts`): user kinds
live in `<stateDir>/agent-kinds.json` (`{version: 1, kinds: [...]}`) —
user-owned, update-safe (the same rule as the agent-assets store, issue
#315). The loader validates entry-at-a-time: a persisted spec that no
longer matches the schema is dropped with a logged warning, not a boot
failure (forward compatibility, mirroring the session registry).

## 3. Personas

Persona content precedence (resolved per spawn — a relaunch re-renders
from the current sources):

1. the kind's agent-assets prompt override (issue #315 — user edits of a
   **shipped** kind's persona),
2. the spec's own `persona` content (**user** kinds),
3. the shipped-default file `agent/prompts/<kind>.md`.

Rendering uses the same `{{PLACEHOLDER}}` machinery as worker prompts
(`apps/daemon/src/orchestrator/prompt.ts`):

| Placeholder | Availability |
|---|---|
| `{{PROJECT_ID}}`, `{{PROJECT_NAME}}`, `{{PROJECT_REPO_URL}}`, `{{PROJECT_DEFAULT_BRANCH}}`, `{{PROJECT_PATH}}` | all project-scoped personas |
| `{{ORCHESTRATOR_SESSION_ID}}` | kinds with `reportTarget: "orchestrator"` |
| `{{PARENT_SESSION_ID}}` | kinds with `reportTarget: "caller"` — the calling session's registry id |

## 4. The CRUD API

`apps/daemon/src/api/agent-kinds.ts`, four endpoints (shared contract in
`packages/shared/src/rest.ts`):

| Endpoint | Semantics |
|---|---|
| `GET /api/agent-kinds` | shipped kinds (in shipped order) then user kinds |
| `POST /api/agent-kinds` | create; 409 on a shipped-name collision or duplicate id |
| `PUT /api/agent-kinds/:kind` | update a user kind; 409 shipped (immutable — edit its persona via agent-assets instead), 404 unknown, 400 when the body's `name` doesn't match the URL kind (ids are immutable) |
| `DELETE /api/agent-kinds/:kind` | delete a user kind; 409 shipped, 404 unknown, 409 when live sessions of the kind exist |

## 5. spawnableBy: the caller-role mapping

A resolvable **agent caller** (explicit `parentSessionId`, or a discovered
calling pane) must be a role the kind lists (`sessionSpawnableRole` in
`apps/daemon/src/api/agent-kind-spawn.ts`); violations are 403. The
mapping from the calling session to a role:

| Calling session | Role |
|---|---|
| orchestrator of the global-agent project | `global` |
| project orchestrator | `orchestrator` |
| worker session whose worker record is `kind: "reviewer"` | `reviewer` |
| any other worker session | `worker` |

User-driven spawns (the web ⋯ menu, the CLI) have no agent caller and are
**unrestricted** — `spawnableBy` is an agent-to-agent guardrail, not a
user permission. The web's spawn menu (#331) filters its entries by
`spawnableBy` as a convenience, but the daemon is the enforcement point.

### Parent-of-any-role linkage

- Spawn options already carry `parentWorkerId` (review agents, #107).
  Generalize the semantics to **parent of any role**: the parent may be a
  global-agent, orchestrator, worker, or reviewer session — the registry
  records the parent session id unchanged, and sidebar nesting follows the
  same lineage grouping workers already use (#187/#249).
- Researcher sessions nest under their caller; audit sessions nest under
  the project orchestrator they report to (their parent is the orchestrator
  by construction when spawned from the ⋯ menu, and the spawning actor's
  session otherwise).
- When no caller can be discovered (a spawn from a project context — the
  web ⋯ menu or a plain terminal — has no calling agent pane), the
  project's orchestrator is the fallback parent for every kind, ensured
  first with its persona (issue #328) — never a bare 409.
- `pideck sessions` renders the kind label and the nesting for free once
  the registry linkage exists.

## 6. Trigger, task, and report routing

The auto-task mechanism (issue #329) is spec-driven: `trigger: "auto"`
kinds get their `taskTemplate` typed into the pane right after the
persona boot; `waitForInput` kinds sit ready for the caller's `question`.
The static spawn schema no longer hardcodes which kinds take a question —
the daemon resolves the spec and answers 409 on a trigger violation
(a question for an auto kind; a missing question for a `waitForInput`
caller-routed kind).

`reportTarget` decides the persona's delivery route:

- `"caller"`: deliver with `pideck send --session {{PARENT_SESSION_ID}}`;
  the spawn resolves the calling session when one is identifiable, and
  falls back to the project orchestrator otherwise (issue #328 — never a
  bare 409).
- `"orchestrator"`: deliver with
  `pideck send --session {{ORCHESTRATOR_SESSION_ID}}`; the spawn falls
  back to the project orchestrator as parent when no caller is
  discoverable.

`callerWaits` is the caller-side completion contract (prompt-gate v2,
issue #333): for a **caller-routed** kind with `callerWaits: true`, the
spawn path delivers a notice into the calling pane — "your <label> agent
is working; it will deliver its report to this session" — so the caller's
flow waits instead of guessing (the notice rides the same pi-auth-gated
path as every spawn prompt). An orchestrator-routed kind reports elsewhere,
so `callerWaits` no-ops there. The spawn response still returns the session
id immediately, and the persona delivers the report asynchronously.

## 7. Guardrails

- **Shipped kinds are immutable and undeletable** (409 on PUT/DELETE).
  Their personas are user-editable via the agent-assets prompt overrides
  (issue #315) instead.
- **No deleting kinds with live sessions** (409; terminate first). The
  sessions keep working — a deleted kind only stops future spawns.
- **Edits affect future spawns only** — and relaunched panes, like every
  persona asset (the launch paths re-render from the current spec).
  A running pane's conversation is never touched.

## 8. Spawn surfaces

- CLI parity: `pideck spawn --project <id> --kind <any-registry-id> --name "<label>"`.
  The CLI validates the kind against the live registry (user kinds
  included), plus the trigger rules and the report-target delivery hint.
  `pideck sessions` / `workers` show the kind.
- Sidebar ⋯ menu (web, issue #331): a "Spawn agent" submenu listing
  built-ins and user kinds, filtered by `spawnableBy` (§5).
- Worker-concurrency settings apply to `workerLike` kinds (real
  workspace, own session); non-worker-like kinds are cheap and exempt.

## 9. Downstream consumers of the schema

- **#331 — Spawn-agent submenu (web)**: reads `GET /api/agent-kinds` (or
  the shared `SHIPPED_AGENT_KINDS` + fetched user kinds), groups built-ins
  vs custom, filters by `spawnableBy`, and uses `trigger` to decide
  prompt-vs-immediate spawn. Must treat unknown kind ids defensively —
  `agentKindInfo(kind)` never throws.
- **#332 — Persona editor v2 (web)**: the CRUD API above is its backend;
  the create/update request schema is the form's validation contract
  (persona required, trigger ⇔ taskTemplate, kebab-case immutable ids,
  shipped kinds read-only with agent-assets overrides for persona edits).
- **#333 — Prompt gate v2 (daemon, merged with this registry)**: the gate
  reads the spec, never a hardcoded kind list — `readOnly` → gated tool
  set (`--exclude-tools edit,write`; read-write kinds get the full set),
  `trigger` → taskTemplate delivery vs sitting ready, `callerWaits` →
  the caller-completion notice above. The pure decisions live in
  `apps/daemon/src/agent/prompt-gate.ts` (`planAgentKindSpawn`) and
  `apps/daemon/src/sessions/agent-kinds.ts` (`agentKindExcludedTools`),
  enumerated per config permutation in `agent/prompt-gate-v2.test.ts`.

## 10. Kind-id migration: `investigator` → `researcher` (issue #335)

The researcher kind was shipped as `investigator` (label `investigate`,
persona file `agent/prompts/investigator.md`). Issue #335 renamed the kind
id, the sidebar label, and the persona file everywhere — schema, registry,
docs, UI strings, CLI, tests — with no alias in the registry (a permanent
alias would keep the legacy vocabulary alive in every switch).

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
