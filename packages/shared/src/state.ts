import { z } from "zod";

export const WorkerStateSchema = z.enum([
  "working",
  "ci",
  "fixing",
  "in_review",
  "addressing",
  "ready",
  "blocked",
  "done",
]);

export type WorkerState = z.infer<typeof WorkerStateSchema>;

export const WorkerStates: readonly WorkerState[] = WorkerStateSchema.options;
