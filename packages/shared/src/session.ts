import { z } from "zod";
import { PersonaSchema } from "./persona.js";
import { WorkerStateSchema } from "./state.js";

export const SessionSchema = z.object({
  id: z.string(),
  persona: PersonaSchema,
  projectId: z.string().nullable(),
  issueNumber: z.number().int().positive().optional(),
  prNumber: z.number().int().positive().optional(),
  tmuxSession: z.string(),
  spawnedAt: z.string(),
  model: z.string().nullable(),
  archivedAt: z.string().optional(),
  lastPromptedHeadSha: z.string().nullable().default(null),
  lastDeliveredIssueCommentId: z.number().int().nullable().default(null),
  lastDeliveredPrCommentId: z.number().int().nullable().default(null),
  lastDeliveredReviewId: z.number().int().nullable().default(null),
  fixAttempts: z.number().int().default(0),
  lastActivityAt: z.string().nullable().default(null),
});

export type Session = z.infer<typeof SessionSchema>;

export const SessionViewSchema = z.object({
  session: SessionSchema,
  state: WorkerStateSchema.nullable(),
  status: z.string(),
  parentSessionId: z.string().nullable(),
});

export type SessionView = z.infer<typeof SessionViewSchema>;
