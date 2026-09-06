/**
 * Typed events emitted by the PR lifecycle pipeline (issue #11).
 *
 * These are the kanban-facing contract the API layer (#9) subscribes to:
 * - `kanban.pr.card` — upsert of the PR's kanban card. The card column
 *   carries the state transition: `in_review` while the PR is open,
 *   `done` once the PR is merged or CI-green + approved.
 * - `kanban.pr.failed` — terminal failure of the PR loop (fix-attempt
 *   limit exhausted, PR closed without merging, owning worker lost). The
 *   API layer decides how to present failure; the card itself keeps its
 *   last known column.
 */

import { z } from "zod";
import { idSchema, isoDateTimeSchema, kanbanCardSchema, refNumberSchema } from "@agentskiss/shared";

export const prPipelineEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("kanban.pr.card"),
    at: isoDateTimeSchema,
    /** Full updated card, so subscribers can upsert it wholesale. */
    card: kanbanCardSchema,
  }),
  z.object({
    type: z.literal("kanban.pr.failed"),
    at: isoDateTimeSchema,
    projectId: idSchema,
    prNumber: refNumberSchema,
    workerId: idSchema,
    /** Last known card state at the moment of failure. */
    card: kanbanCardSchema,
    /** Machine-readable failure reason (e.g. `fix_attempt_limit_exhausted`). */
    reason: z.string().min(1),
  }),
]);

export type PRPipelineEvent = z.infer<typeof prPipelineEventSchema>;

export type PRPipelineEventEmitter = (event: PRPipelineEvent) => void;
