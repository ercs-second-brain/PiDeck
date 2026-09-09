/**
 * CLI action routes (agent/README.md: "Finalized in #9" daemon actions).
 *
 * These back the `pideck spawn` / `pideck send` CLI commands and —
 * unlike the webapp contract map — have no entries in
 * `packages/shared/src/rest.ts`, so their request schemas live here, built
 * from shared domain primitives.
 */

import { z } from "zod";
import { agentKindSchema, idSchema, refNumberSchema } from "@pideck/shared";

/**
 * `POST /api/projects/:projectId/spawn` — spawn a worker in a project, or
 * — with `kind` — a preset-prompt agent-kind session (docs/agent-kinds.md,
 * `pideck spawn --kind`). One route, two spawn types: kind spawns carry
 * `kind` (+ the investigator's `question`, an explicit `parentSessionId`)
 * and never `issueNumber`/`prompt` (the persona is the prompt; agent kinds
 * are not issue-owned); worker spawns keep the original shape.
 */
export const projectSpawnSchema = z
  .object({
    /** GitHub issue the worker works; omitted for freeform (`--prompt`) workers. */
    issueNumber: refNumberSchema.optional(),
    /** Sidebar label, ≤ 20 characters (pinned by the spawn-worker skill). */
    name: z.string().min(1).max(20),
    /** Initial task prompt delivered into the worker's pane. */
    prompt: z.string().min(1).optional(),
    /** Agent kind (docs/agent-kinds.md) — present marks an agent-kind spawn. */
    kind: agentKindSchema.optional(),
    /** The investigator's question (`pideck spawn --kind investigator --question`). */
    question: z.string().min(1).optional(),
    /** Explicit parent session of any role (docs/agent-kinds.md §3); resolved from the spawn context when omitted. */
    parentSessionId: idSchema.optional(),
  })
  .refine((input) => input.kind !== undefined || input.issueNumber !== undefined || input.prompt !== undefined, {
    message: "spawn needs --issue <number>, --prompt <task>, or --kind <agent-kind>",
  })
  .refine(
    (input) => input.kind === undefined || (input.issueNumber === undefined && input.prompt === undefined),
    { message: "--issue/--prompt cannot be combined with --kind (agent kinds are not issue-owned; the persona is the prompt)" },
  )
  .refine((input) => input.question === undefined || input.kind === "investigator", {
    message: "--question is investigator-only (audit kinds take no input)",
  });

/** `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane. */
export const sessionSendSchema = z.object({
  message: z.string().min(1),
});

/**
 * `POST /api/sessions/report-pr` — a worker session reports the PR it
 * opened (issue #49). The CLI resolves `tmuxSession` from its own pane
 * context (`TMUX` + `tmux display-message`), so the body carries the
 * calling session's identity, not a caller-chosen id.
 */
export const sessionReportPrSchema = z.object({
  /** Tmux session name the calling CLI self-identified from its pane. */
  tmuxSession: z.string().min(1),
  /** PR number the worker opened. */
  prNumber: refNumberSchema,
});
