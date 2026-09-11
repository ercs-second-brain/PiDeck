import { z } from "zod";
import { PersonaSchema } from "./persona.js";
import { ProjectSchema, ProjectSettingsSchema } from "./project.js";
import { SessionViewSchema } from "./session.js";
import { GlobalSettingsSchema } from "./settings.js";

export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

export const StatusSchema = z.object({
  version: z.string(),
  stateDir: z.string(),
  pollIntervalSeconds: z.number().int().positive(),
});
export type Status = z.infer<typeof StatusSchema>;

export const ProjectCreateSchema = z.object({
  repoUrl: z.string().min(1),
  name: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
});
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

export const ProjectUpdateSchema = ProjectSchema.pick({
  name: true,
  defaultBranch: true,
  path: true,
}).partial();
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

export const SessionSendSchema = z.object({ text: z.string().min(1) });
export type SessionSend = z.infer<typeof SessionSendSchema>;

export const SessionLogSchema = z.object({ log: z.string() });
export type SessionLog = z.infer<typeof SessionLogSchema>;

export const PromptSchema = z.object({
  persona: PersonaSchema,
  prompt: z.string(),
  edited: z.boolean(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptPutSchema = z.object({ prompt: z.string() });
export type PromptPut = z.infer<typeof PromptPutSchema>;

export const ProbeSchema = z.object({ ok: z.boolean(), detail: z.string() });
export type Probe = z.infer<typeof ProbeSchema>;

export const UpdateCheckSchema = z.object({
  updateAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;

export interface RestEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  request?: z.ZodType;
  response: z.ZodType;
}

export const restEndpoints = {
  status: { method: "GET", path: "/api/status", response: StatusSchema },

  projectList: { method: "GET", path: "/api/projects", response: z.array(ProjectSchema) },
  projectCreate: {
    method: "POST",
    path: "/api/projects",
    request: ProjectCreateSchema,
    response: ProjectSchema,
  },
  projectGet: { method: "GET", path: "/api/projects/:id", response: ProjectSchema },
  projectUpdate: {
    method: "PATCH",
    path: "/api/projects/:id",
    request: ProjectUpdateSchema,
    response: ProjectSchema,
  },
  projectDelete: { method: "DELETE", path: "/api/projects/:id", response: OkSchema },
  projectSettingsGet: {
    method: "GET",
    path: "/api/projects/:id/settings",
    response: ProjectSettingsSchema,
  },
  projectSettingsPut: {
    method: "PUT",
    path: "/api/projects/:id/settings",
    request: ProjectSettingsSchema,
    response: ProjectSettingsSchema,
  },

  sessionList: { method: "GET", path: "/api/sessions", response: z.array(SessionViewSchema) },
  projectSessionList: {
    method: "GET",
    path: "/api/projects/:id/sessions",
    response: z.array(SessionViewSchema),
  },
  sessionSend: {
    method: "POST",
    path: "/api/sessions/:id/send",
    request: SessionSendSchema,
    response: OkSchema,
  },
  sessionTerminate: { method: "POST", path: "/api/sessions/:id/terminate", response: OkSchema },
  sessionLog: { method: "GET", path: "/api/sessions/:id/log", response: SessionLogSchema },

  globalSettingsGet: { method: "GET", path: "/api/settings", response: GlobalSettingsSchema },
  globalSettingsPut: {
    method: "PUT",
    path: "/api/settings",
    request: GlobalSettingsSchema,
    response: GlobalSettingsSchema,
  },

  promptGet: { method: "GET", path: "/api/prompts/:persona", response: PromptSchema },
  promptPut: {
    method: "PUT",
    path: "/api/prompts/:persona",
    request: PromptPutSchema,
    response: PromptSchema,
  },
  promptReset: { method: "POST", path: "/api/prompts/:persona/reset", response: PromptSchema },

  probePi: { method: "GET", path: "/api/onboarding/pi", response: ProbeSchema },
  probeGh: { method: "GET", path: "/api/onboarding/gh", response: ProbeSchema },

  updateCheck: { method: "GET", path: "/api/update", response: UpdateCheckSchema },
  updateApply: { method: "POST", path: "/api/update/apply", response: OkSchema },
} satisfies Record<string, RestEndpoint>;

export type RestEndpointName = keyof typeof restEndpoints;
