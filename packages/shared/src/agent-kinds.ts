/**
 * Agent-kind registry v2 (issue #330 — docs/agent-kinds.md): the spec-v2
 * schema, the shipped built-ins as data, and the derived presentation
 * metadata. Split from domain.ts (KISS line budgets); re-exported through
 * the package index, so consumers keep importing from "@pideck/shared".
 */

import { z } from "zod";

import { agentKindIdSchema, idSchema } from "./domain.js";

// ---------------------------------------------------------------------------
// Agent kinds v2 (issue #330 — docs/agent-kinds.md): user-definable kinds
// ---------------------------------------------------------------------------

/**
 * Agent kinds: sessions spawned with a pre-baked persona prompt and a
 * fixed report route, instead of a bespoke code path per kind. Deliberately
 * distinct from {@link workerKindSchema} (`implementer`/`reviewer`), which
 * keeps its meaning for PR-ownership semantics: a spawn is either a worker
 * (issue/PR-owned) or an agent-kind session (preset persona,
 * report-routed).
 *
 * Kind ids are user-defined since registry v2 (issue #330): a kebab-case
 * slug, safe as a filename and a CLI-visible name. The three shipped kinds
 * keep their ids; everything downstream (session records, spawn requests,
 * CRUD paths) speaks ids, never a hardcoded list.
 */
export type AgentKind = z.infer<typeof agentKindIdSchema>;

/**
 * Which agent roles may spawn a kind (spec v2 `spawnableBy`): the caller's
 * session role, mapped as global agent (the workspace-level orchestrator),
 * project orchestrator, implementer worker, or review agent. User-driven
 * spawns (the web ⋯ menu, the CLI) carry no agent caller and are not
 * restricted by this list.
 */
export const AGENT_KIND_SPAWNABLE_ROLES = ["global", "orchestrator", "worker", "reviewer"] as const;
export const agentKindSpawnableRoleSchema = z.enum(AGENT_KIND_SPAWNABLE_ROLES);
export type AgentKindSpawnableRole = z.infer<typeof agentKindSpawnableRoleSchema>;

/**
 * Spawn trigger (spec v2): `auto` delivers the kind's `taskTemplate` right
 * after the persona boot (the agent starts working unprompted);
 * `waitForInput` types nothing — the kind is reactive and waits for the
 * input its caller supplies with the spawn (the researcher's question).
 */
export const agentKindTriggerSchema = z.enum(["auto", "waitForInput"]);
export type AgentKindTrigger = z.infer<typeof agentKindTriggerSchema>;

/**
 * Who receives an agent kind's final report (spec v2). The delivery
 * mechanism is always `pideck send --session <id>`: kinds with target
 * `caller` deliver to `{{PARENT_SESSION_ID}}` (the calling session), kinds
 * with `orchestrator` deliver to `{{ORCHESTRATOR_SESSION_ID}}` (the
 * project orchestrator).
 */
export const agentKindReportTargetSchema = z.enum(["caller", "orchestrator"]);
export type AgentKindReportTarget = z.infer<typeof agentKindReportTargetSchema>;

/**
 * One agent-kind spec (registry v2, issue #330): the complete, data-driven
 * definition of a kind — the single shape the daemon spawn/relaunch/reconcile
 * paths and the web consume. Built-in kinds ship as this exact data
 * ({@link SHIPPED_AGENT_KINDS} — if the schema cannot represent a shipped
 * kind, it is wrong); user kinds are stored as the same shape in the daemon
 * state dir and managed over the CRUD API.
 */
export const agentKindSpecObjectSchema = z.object({
  /** Kind id — kebab-case slug, unique across shipped + user kinds. */
  name: agentKindIdSchema,
  /** Sidebar label — the spawn's default `--name` (the web renders "◇ <label>"). */
  label: z.string().min(1).max(20),
  /** The spawn-menu button's display text; falls back to {@link label}. */
  menuLabel: z.string().min(1).max(40).optional(),
  /** One-line behavior summary (the spawn-menu buttons' title); falls back to {@link label}. */
  description: z.string().min(1).optional(),
  /**
   * Persona content (the boot prompt body, `{{PLACEHOLDER}}`-rendered like
   * every persona). User kinds carry their content here (required — there
   * is no shipped file to fall back to). Shipped kinds omit it: the
   * shipped-default fallback is `agent/prompts/<name>.md`, and a user
   * override stored via the agent-assets prompt-override surface (issue
   * #315) takes precedence over both.
   */
  persona: z.string().min(1).optional(),
  /** Agent roles allowed to spawn the kind (user-driven spawns are unrestricted). */
  spawnableBy: z.array(agentKindSpawnableRoleSchema).min(1),
  /** Whether the calling agent blocks for the report (caller-persona guidance + UI metadata). */
  callerWaits: z.boolean(),
  /** Whether the pane launches with the write tools excluded (`--exclude-tools edit,write`). */
  readOnly: z.boolean(),
  /** `auto` ⇔ `taskTemplate` is set (refined below): what happens right after the boot. */
  trigger: agentKindTriggerSchema,
  /**
   * The work order typed into the pane after the persona boot (issue
   * #329), rendered with the persona's placeholder set (project + report
   * target). Required exactly when `trigger` is `auto`.
   */
  taskTemplate: z.string().min(1).optional(),
  /** Who receives the final report: the calling session or the project orchestrator. */
  reportTarget: agentKindReportTargetSchema,
  /**
   * Worker-like spawns occupy a real workspace — a fresh per-session
   * worktree (issue #287) — and count against the project's
   * `workerConcurrency` cap. Cheap kinds (the researcher) run read-only in
   * the project clone and are exempt.
   */
  workerLike: z.boolean(),
});

/** Cross-field rule: `auto` kinds carry a task template, reactive kinds do not. */
const refineTaskTrigger = (spec: { trigger: string; taskTemplate?: string }): boolean =>
  spec.trigger === "auto" ? spec.taskTemplate !== undefined : spec.taskTemplate === undefined;

/**
 * A complete kind spec (stored or shipped). Adds the trigger ⇔ taskTemplate
 * pairing on top of the base object: an `auto` kind without a template
 * would boot idle (bug #329); a `waitForInput` kind with one would double
 * its input story.
 */
export const agentKindSpecSchema = agentKindSpecObjectSchema.refine(refineTaskTrigger, {
  message: "trigger `auto` requires a taskTemplate; trigger `waitForInput` takes none (the caller supplies input)",
  path: ["taskTemplate"],
});
export type AgentKindSpec = z.infer<typeof agentKindSpecObjectSchema>;

/**
 * Body of the agent-kind CRUD create/update requests (`POST /api/agent-kinds`,
 * `PUT /api/agent-kinds/:kind`): a complete kind spec whose persona content
 * is mandatory — user-defined kinds have no shipped-default file to fall
 * back to. The update body's `name` must match the `:kind` path param.
 */
export const upsertAgentKindRequestSchema = agentKindSpecObjectSchema
  .refine(refineTaskTrigger, {
    message: "trigger `auto` requires a taskTemplate; trigger `waitForInput` takes none (the caller supplies input)",
    path: ["taskTemplate"],
  })
  .refine((spec) => spec.persona !== undefined, {
    message: "user-defined kinds carry their persona content (only shipped kinds fall back to agent/prompts/<name>.md)",
    path: ["persona"],
  });
export type UpsertAgentKindRequest = z.infer<typeof agentKindSpecObjectSchema>;

/** Response of `GET /api/agent-kinds`: every spawnable kind, shipped first. */
export const agentKindListSchema = z.object({ kinds: z.array(agentKindSpecSchema) });
export type AgentKindList = z.infer<typeof agentKindListSchema>;

/**
 * The shipped built-in kinds (issues #297/#300/#302/#330): expressed AS
 * spec-v2 data — the daemon registry dogfoods this table, and the web ⋯
 * menu (until the spawn-submenu ticket) and CLI render from it. Persona
 * content lives in the shipped `agent/prompts/<name>.md` files (the
 * shipped-default fallback; user overrides via agent-assets, issue #315).
 * All three are read-only by design: findings and reports, never edits,
 * commits, or PRs.
 */
export const SHIPPED_AGENT_KINDS: readonly AgentKindSpec[] = [
  {
    name: "researcher",
    label: "research",
    menuLabel: "Researcher",
    description: "Spawn a researcher — it researches one question against the codebase and reports back",
    spawnableBy: ["global", "orchestrator", "worker", "reviewer"],
    callerWaits: true,
    readOnly: true,
    // Reactive by config (issues #329/#330): the researcher waits for the
    // question its caller delivers with the spawn — no taskTemplate.
    trigger: "waitForInput",
    reportTarget: "caller",
    workerLike: false,
  },
  {
    name: "devex-audit",
    label: "devex-audit",
    menuLabel: "Devex audit",
    description: "Spawn a devex audit — mines prior sessions for friction, reports to the orchestrator",
    spawnableBy: ["global", "orchestrator", "worker", "reviewer"],
    callerWaits: false,
    readOnly: true,
    trigger: "auto",
    taskTemplate:
      "Begin the devex audit of {{PROJECT_NAME}} now: mine the prior pi sessions for friction, time, and money " +
      "sinks per your persona's methodology (credentials REDACTED; read-only), then deliver the " +
      "full report to the project orchestrator with `pideck send --session {{ORCHESTRATOR_SESSION_ID}}`.",
    reportTarget: "orchestrator",
    workerLike: true,
  },
  {
    name: "kiss-audit",
    label: "kiss-audit",
    menuLabel: "KISS audit",
    description: "Spawn a KISS audit — complexity findings, reported to the orchestrator",
    spawnableBy: ["global", "orchestrator", "worker", "reviewer"],
    callerWaits: false,
    readOnly: true,
    trigger: "auto",
    taskTemplate:
      "Begin the KISS audit now: audit the project at {{PROJECT_PATH}} per your persona's " +
      "methodology (read-only — findings, never fixes), then deliver the full report to the " +
      "project orchestrator with `pideck send --session {{ORCHESTRATOR_SESSION_ID}}`.",
    reportTarget: "orchestrator",
    workerLike: true,
  },
];

/**
 * The shipped kinds' ids in spawn-menu order (issue #324's table, now
 * derived from {@link SHIPPED_AGENT_KINDS}). The web ⋯ menu lists these
 * until the spawn-submenu ticket widens it to the full registry
 * (`GET /api/agent-kinds`).
 */
export const AGENT_KINDS: readonly string[] = SHIPPED_AGENT_KINDS.map((kind) => kind.name);

/** Per-kind presentation metadata (issue #324) — the web renders from this. */
export interface AgentKindInfo {
  /** Sidebar label — the spawn's default `--name` (the web renders "◇ <label>"). */
  label: string;
  /** The spawn-menu button's display text ("Researcher"). */
  menuLabel: string;
  /** One-line behavior summary (the spawn-menu buttons' title). */
  description: string;
  /**
   * Whether the kind takes free-text input (the researcher's question):
   * drives the web input modal, the CLI `--question` rules, and the spawn
   * schemas' question handling.
   */
  takesInput: boolean;
}

/** Presentation metadata for one spec: explicit fields, falling back to the label. */
function agentKindSpecInfo(spec: Pick<AgentKindSpec, "label" | "trigger"> & Partial<Pick<AgentKindSpec, "menuLabel" | "description">>): AgentKindInfo {
  return {
    label: spec.label,
    menuLabel: spec.menuLabel ?? spec.label,
    description: spec.description ?? spec.label,
    takesInput: spec.trigger === "waitForInput",
  };
}

/**
 * The shipped kinds' presentation metadata (issue #324's table, now derived
 * from {@link SHIPPED_AGENT_KINDS} — one source, no drift). Keyed by kind id
 * as a plain record: user-defined kinds are NOT in here — resolve any kind
 * id (shipped or user) through {@link agentKindInfo} instead.
 */
export const AGENT_KIND_INFO: Record<string, AgentKindInfo> = Object.fromEntries(
  SHIPPED_AGENT_KINDS.map((kind) => [kind.name, agentKindSpecInfo(kind)]),
);

/**
 * Presentation metadata for any kind id (issue #330): shipped kinds resolve
 * to their table row; user kinds synthesize one from their id — the web
 * never crashes on an unknown kind, it just renders the bare id.
 */
export function agentKindInfo(kind: string): AgentKindInfo {
  return (
    AGENT_KIND_INFO[kind] ?? {
      label: kind,
      menuLabel: kind,
      description: `Spawn the "${kind}" agent`,
      takesInput: false,
    }
  );
}

/**
 * Body of the agent-kind spawn (docs/agent-kinds.md): the persona IS the
 * prompt, so a spawn carries the kind, a sidebar label, and — for
 * input-taking kinds (`trigger: "waitForInput"`) — the free-text input to
 * research. `parentSessionId` is the explicit parent-of-any-role; when
 * omitted the daemon resolves the calling pane and falls back to the
 * project orchestrator for orchestrator-routed kinds.
 */
export const spawnAgentRequestSchema = z.object({
  kind: agentKindIdSchema,
  /** Sidebar label, <= 20 characters (pinned by the spawn-worker skill). */
  name: z.string().min(1).max(20),
  /** Question typed into the pane after launch (waitForInput kinds' input). */
  question: z.string().min(1).optional(),
  /** Parent session of any role (docs/agent-kinds.md §3); resolved from the spawn context when omitted. */
  parentSessionId: idSchema.optional(),
});
export type SpawnAgentRequest = z.infer<typeof spawnAgentRequestSchema>;
