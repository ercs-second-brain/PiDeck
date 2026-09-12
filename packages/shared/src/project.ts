import { z } from "zod";

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  repoUrl: z.string(),
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string(),
  path: z.string(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const ProjectSettingsSchema = z.object({
  workerConcurrency: z.number().int().min(1).default(3),
  maxFixAttempts: z.number().int().min(1).default(5),
  contextLimitPercent: z.number().int().min(1).max(100).default(30),
  stallMinutes: z.number().int().min(1).default(45),
  autoMerge: z.boolean().default(false),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectCreateSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("clone"),
    repoUrl: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal("create"),
    name: z.string().min(1),
    private: z.boolean(),
  }),
]);
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
