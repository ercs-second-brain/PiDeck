/**
 * Preset-prompt agent-kind registry (docs/agent-kinds.md, issues
 * #297/#300/#302).
 *
 * The single table the daemon spawn path reads: an agent-kind spawn is a
 * **session** (never a worker record) with a pre-baked persona prompt —
 * rendered from `agent/prompts/<kind>.md` exactly like the orchestrator
 * personas (see `orchestrator/prompt.ts`) — and a fixed report route
 * (shared `AGENT_KIND_REPORT_TARGET`; the delivery mechanism is always
 * `pideck send`). Adding a kind = an `agentKindSchema` entry, a persona
 * file, and one row here — nothing else.
 *
 * All kinds are read-only by design (findings and reports, never edits/
 * commits/PRs). What differs per kind below: the persona file, whether the
 * spawn occupies a worker-like workspace — a fresh per-session worktree
 * branched off origin's default branch (issue #287), and therefore counts
 * against the project's worker-concurrency cap — and whether the pane is
 * enforced read-only (write tools excluded). Presentation metadata (sidebar
 * label, ⋯-menu text, input rules) lives in the shared `AGENT_KIND_INFO`
 * (issue #324) — one row per kind across daemon and web.
 */

import path from "node:path";

import type { AgentKind } from "@pideck/shared";

import type { ProjectLayout } from "./layout.js";
import { sanitizeTmuxSegment } from "./tmux-commands.js";

export interface AgentKindSpec {
  /** Persona template file under `agent/prompts/`, rendered like worker prompts. */
  personaFile: string;
  /**
   * Worker-like spawns occupy a real workspace — a fresh per-session
   * worktree (issue #287) — and count against the project's
   * `workerConcurrency` cap. Cheap kinds (researcher) run read-only in
   * the project clone and are exempt.
   */
  workerLike: boolean;
  /** When true the pane launches with the write tools excluded (no edit/write). */
  readOnly: boolean;
}

const AGENT_KIND_SPECS: Record<AgentKind, AgentKindSpec> = {
  researcher: {
    personaFile: "researcher.md",
    workerLike: false,
    readOnly: true,
  },
  "devex-audit": {
    personaFile: "devex-audit.md",
    workerLike: true,
    readOnly: true,
  },
  "kiss-audit": {
    personaFile: "kiss-audit.md",
    workerLike: true,
    readOnly: true,
  },
};

/** Total lookup (the enum guarantees coverage); kept for readable call sites. */
export function agentKindSpec(kind: AgentKind): AgentKindSpec {
  return AGENT_KIND_SPECS[kind];
}

/**
 * Built-in tools excluded from read-only agent kinds' panes via
 * `pi --exclude-tools`: pi's file-mutation tools. Search/inspection tools
 * (read, grep, glob) and bash stay available; the persona forbids
 * state-changing shell use, the exclusion removes the direct write paths.
 */
const READ_ONLY_EXCLUDED_TOOLS = ["edit", "write"] as const;

/**
 * The pane launch command for an agent-kind session: pi with the rendered
 * persona appended to its system prompt and the session id in the
 * environment (agent/README.md: every agent session gets `PD_SESSION_ID`);
 * read-only kinds additionally exclude the write tools; user skills applied
 * to the kind's persona (issue #315) are surfaced via `--skill <file>`. The
 * persona name IS the kind (`agent/prompts/<kind>.md`). Recorded verbatim
 * on the session, so relaunch/reconcile re-run the identical command
 * (issues #27/#117).
 */
export function agentKindLaunchCommand(options: {
  sessionId: string;
  promptFile: string;
  readOnly: boolean;
  /** User-skill argv pairs (issue #315): `--skill <file>` per applied skill. */
  skillArgs?: string[];
}): string[] {
  return [
    "env",
    `PD_SESSION_ID=${options.sessionId}`,
    "pi",
    "--append-system-prompt",
    options.promptFile,
    ...(options.skillArgs ?? []),
    ...(options.readOnly ? ["--exclude-tools", READ_ONLY_EXCLUDED_TOOLS.join(",")] : []),
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
