/**
 * Agent-kind registry v2 (docs/agent-kinds.md, issues #297/#300/#302/#330).
 *
 * The single lookup the daemon spawn/relaunch/reconcile paths read: an
 * agent-kind spawn is a **session** (never a worker record) with a
 * pre-baked persona prompt — rendered exactly like the orchestrator
 * personas (see `orchestrator/prompt.ts`) — and a fixed report route (the
 * delivery mechanism is always `pideck send`). Everything that varies per
 * kind is data: the {@link AgentKindSpec} schema in `@pideck/shared`.
 *
 * Registry v2 (issue #330) makes kinds user-definable. Resolution order:
 * user-defined kinds (the {@link AgentKindStore}, state-dir persisted and
 * update-safe) first, then the shipped built-ins
 * (`SHIPPED_AGENT_KINDS` in shared — the built-ins ARE spec-v2 data, the
 * dogfood check). No hardcoded kind names remain in the daemon: adding or
 * editing a kind is data, never code.
 *
 * Persona content resolution (at launch, in `orchestrator/bootstrap.ts`):
 * the kind's agent-assets prompt override (issue #315, shipped kinds)
 * → the spec's own `persona` content (user kinds) → the shipped
 * `agent/prompts/<name>.md` file (shipped-default fallback).
 */

import { SHIPPED_AGENT_KINDS, type AgentKindSpec } from "@pideck/shared";

import path from "node:path";

import { renderTemplate, type PromptPlaceholder } from "../orchestrator/prompt.js";
import type { ProjectLayout } from "./layout.js";
import { sanitizeTmuxSegment } from "./tmux-commands.js";

/** Read-only view of the registry (the spawn paths depend on this, not the class). */
export interface AgentKindLookup {
  /** One kind spec by id (user kinds first, then shipped); `undefined` when unknown. */
  get(name: string): AgentKindSpec | undefined;
}

/**
 * The agent-kind registry: user-defined kinds (via the store) shadowed
 * over the shipped built-ins. Constructed without a store it resolves
 * shipped kinds only (the default for tests and tools that never see user
 * kinds); the daemon context wires the store-backed instance.
 */
export class AgentKindRegistry implements AgentKindLookup {
  constructor(private readonly userKinds?: AgentKindLookup & { list(): AgentKindSpec[] }) {}

  get(name: string): AgentKindSpec | undefined {
    return this.userKinds?.get(name) ?? SHIPPED_AGENT_KINDS.find((kind) => kind.name === name);
  }

  /** Every spawnable kind: shipped first, then user-defined. */
  list(): AgentKindSpec[] {
    return [...SHIPPED_AGENT_KINDS, ...(this.userKinds?.list() ?? [])];
  }

  /** Whether the id belongs to a shipped built-in (immutable spec, undeletable). */
  isShipped(name: string): boolean {
    return SHIPPED_AGENT_KINDS.some((kind) => kind.name === name);
  }
}

/**
 * Renders a kind's auto-task (issue #329) with the persona's placeholder
 * set — `{{PROJECT_*}}` plus the report-target session id
 * (`{{ORCHESTRATOR_SESSION_ID}}` or `{{PARENT_SESSION_ID}}`, mirroring the
 * persona rendering in the bootstrap). `undefined` for task-less kinds
 * (`trigger: "waitForInput"`): nothing is typed after the persona boot.
 * Same `{{KEY}}` substitution as every prompt template
 * (orchestrator/prompt.ts) — unknown keys are left verbatim so the
 * templates and the callers evolve independently.
 */
export function renderAgentKindTask(
  spec: AgentKindSpec,
  values: Partial<Record<PromptPlaceholder, string>>,
): string | undefined {
  return spec.taskTemplate !== undefined ? renderTemplate(spec.taskTemplate, values) : undefined;
}

/**
 * Tools excluded from an agent kind's pane via `pi --exclude-tools`, from
 * the kind spec (prompt-gate v2, issue #333): read-only kinds get the
 * gated tool set — pi's file-mutation tools (search/inspection tools and
 * bash stay; the persona governs shell behavior, the exclusion removes the
 * direct write paths) — read-write kinds get the full set. No kind names
 * appear here; the spec's `readOnly` flag is the only input.
 */
const READ_ONLY_EXCLUDED_TOOLS = ["edit", "write"] as const;

export function agentKindExcludedTools(spec: Pick<AgentKindSpec, "readOnly">): readonly string[] {
  return spec.readOnly ? READ_ONLY_EXCLUDED_TOOLS : [];
}

/**
 * The pane launch command for an agent-kind session: pi with the rendered
 * persona appended to its system prompt and the session id in the
 * environment (agent/README.md: every agent session gets `PD_SESSION_ID`);
 * the kind spec's `readOnly` flag gates the tool set (issue #333); user
 * skills applied to the kind's persona (issue #315) are surfaced via
 * `--skill <file>`. Recorded verbatim on the session, so relaunch/
 * reconcile re-run the identical command (issues #27/#117).
 */
export function agentKindLaunchCommand(options: {
  sessionId: string;
  promptFile: string;
  /** The kind spec — `readOnly` decides the tool set (issue #333). */
  spec: Pick<AgentKindSpec, "readOnly">;
  /** User-skill argv pairs (issue #315): `--skill <file>` per applied skill. */
  skillArgs?: string[];
}): string[] {
  const excluded = agentKindExcludedTools(options.spec);
  return [
    "env",
    `PD_SESSION_ID=${options.sessionId}`,
    "pi",
    "--append-system-prompt",
    options.promptFile,
    ...(options.skillArgs ?? []),
    ...(excluded.length > 0 ? ["--exclude-tools", excluded.join(",")] : []),
  ];
}

/**
 * Where the rendered persona prompt file lives: one file per agent session
 * in the project's state dir, kept after launch so relaunch/resurrect
 * (issues #27/#117) re-run the identical command against the same file.
 */
export function agentKindPromptFilePath(layout: ProjectLayout, projectId: string, sessionId: string): string {
  return path.join(layout.projectDir(projectId), `agent-prompt-${sanitizeTmuxSegment(sessionId)}.md`);
}
