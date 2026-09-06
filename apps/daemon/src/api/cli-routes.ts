/**
 * CLI action routes (agent/README.md: "Finalized in #9" daemon actions).
 *
 * These back the `agentskiss spawn` / `agentskiss send` CLI commands and —
 * unlike the webapp contract map — have no entries in
 * `packages/shared/src/rest.ts`, so their request schemas live here, built
 * from shared domain primitives.
 */

import { z } from "zod";
import { refNumberSchema } from "@agentskiss/shared";

/** `POST /api/projects/:projectId/spawn` — spawn a worker in a project. */
export const projectSpawnSchema = z
  .object({
    /** GitHub issue the worker works; omitted for freeform (`--prompt`) workers. */
    issueNumber: refNumberSchema.optional(),
    /** Sidebar label, ≤ 20 characters (pinned by the spawn-worker skill). */
    name: z.string().min(1).max(20),
    /** Initial task prompt delivered into the worker's pane. */
    prompt: z.string().min(1).optional(),
  })
  .refine((input) => input.issueNumber !== undefined || input.prompt !== undefined, {
    message: "spawn needs --issue <number> or --prompt <task>",
  });

/** `POST /api/sessions/:sessionId/send` — deliver a message into a tmux pane. */
export const sessionSendSchema = z.object({
  message: z.string().min(1),
});

/** `POST /api/sessions/:sessionId/keys` — raw tmux send-keys (daemon-internal). */
export const sessionKeysSchema = z.object({
  keys: z.string(),
  enter: z.boolean().optional(),
});
