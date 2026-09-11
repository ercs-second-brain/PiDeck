/**
 * CLI action routes (agent/README.md: "Finalized in #9" daemon actions).
 *
 * These back the `pideck spawn` / `pideck send` CLI commands and —
 * unlike the webapp contract map — have no entries in
 * `packages/shared/src/rest.ts`, so their request schemas live here, built
 * from shared domain primitives.
 */

import { z } from "zod";
import { agentKindIdSchema, idSchema, refNumberSchema } from "@pideck/shared";

/**
 * `POST /api/projects/:projectId/spawn` — spawn a worker in a project, or
 * — with `kind` — a preset-prompt agent-kind session (docs/agent-kinds.md,
 * `pideck spawn --kind`). One route, two spawn types: kind spawns carry
 * `kind` (+ the researcher's `question`, an explicit `parentSessionId`)
 * and never `issueNumber`/`prompt` (the persona is the prompt; agent kinds
 * are not issue-owned); worker spawns keep the original shape.
 */
export const projectSpawnSchema = z
  .object({
    /** GitHub issue the worker works; omitted for freeform (`--prompt`) workers. */
    issueNumber: refNumberSchema.optional(),
    /** Sidebar label, ≤ 20 characters (pinned by `pideck spawn --help`). */
    name: z.string().min(1).max(20),
    /** Initial task prompt delivered into the worker's pane. */
    prompt: z.string().min(1).optional(),
    /** Agent kind id (docs/agent-kinds.md) — present marks an agent-kind spawn. */
    kind: agentKindIdSchema.optional(),
    /** A waitForInput kind's input (`pideck spawn --kind <kind> --question`). */
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
  );
  // The question rule (waitForInput kinds only, issue #330) is enforced
  // dynamically in the spawn handler — this static schema cannot know the
  // user-defined kinds' triggers.

/** `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane. */
export const sessionSendSchema = z.object({
  message: z.string().min(1),
});

