import { z } from "zod";
import { PersonaSchema } from "./persona.js";
import {
  ProjectCreateSchema,
  ProjectSchema,
  ProjectSettingsSchema,
} from "./project.js";
import {
  SessionTraceSchema,
  SessionTranscriptSchema,
  SessionViewSchema,
} from "./session.js";
import {
  GlobalSettingsPutSchema,
  GlobalSettingsReadSchema,
} from "./settings.js";

export const OkSchema = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof OkSchema>;

export const GithubStatusSchema = z.object({
  throttledUntil: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type GithubStatus = z.infer<typeof GithubStatusSchema>;

export const StatusSchema = z.object({
  version: z.string(),
  stateDir: z.string(),
  pollIntervalSeconds: z.number().int().positive(),
  piReady: z.boolean(),
  ghReady: z.boolean(),
  github: GithubStatusSchema,
});
export type Status = z.infer<typeof StatusSchema>;

export const SessionSendSchema = z.object({ text: z.string().min(1) });
export type SessionSend = z.infer<typeof SessionSendSchema>;

export const SessionLogSchema = z.object({ log: z.string() });
export type SessionLog = z.infer<typeof SessionLogSchema>;

export const SessionLabelSchema = z.object({ label: z.string().min(1) });
export type SessionLabel = z.infer<typeof SessionLabelSchema>;

export const SessionContextSchema = z.object({
  repo: z.string(),
  defaultBranch: z.string(),
  issueNumber: z.number().int().nullable(),
  prNumber: z.number().int().nullable(),
  branch: z.string().nullable(),
});
export type SessionContext = z.infer<typeof SessionContextSchema>;

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

export const PiProbeSchema = ProbeSchema.extend({
  providers: z.array(z.string()),
  models: z.array(z.string()),
  defaultModel: z.string().nullable(),
});
export type PiProbe = z.infer<typeof PiProbeSchema>;

export const UpdateCheckSchema = z.object({
  updateAvailable: z.boolean(),
  latestVersion: z.string().nullable(),
});
export type UpdateCheck = z.infer<typeof UpdateCheckSchema>;

/** The one-time code and URL gh's device flow shows for the review account. */
export const ReviewLoginStartSchema = z.object({ code: z.string(), url: z.string() });
export type ReviewLoginStart = z.infer<typeof ReviewLoginStartSchema>;

export const ReviewLoginStatusSchema = z.object({
  status: z.enum(["pending", "done", "failed"]),
  detail: z.string().nullable(),
});
export type ReviewLoginStatus = z.infer<typeof ReviewLoginStatusSchema>;

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
  sessionLabel: {
    method: "PATCH",
    path: "/api/sessions/:id",
    request: SessionLabelSchema,
    response: SessionViewSchema,
  },
  sessionTerminate: { method: "POST", path: "/api/sessions/:id/terminate", response: OkSchema },
  sessionLog: { method: "GET", path: "/api/sessions/:id/log", response: SessionLogSchema },
  sessionTrace: {
    method: "GET",
    path: "/api/sessions/:id/trace",
    response: SessionTraceSchema,
  },
  sessionTranscript: {
    method: "GET",
    path: "/api/sessions/:id/transcript",
    response: SessionTranscriptSchema,
  },
  sessionContext: {
    method: "GET",
    path: "/api/sessions/:id/context",
    response: SessionContextSchema,
  },

  globalSettingsGet: {
    method: "GET",
    path: "/api/settings",
    response: GlobalSettingsReadSchema,
  },
  globalSettingsPut: {
    method: "PUT",
    path: "/api/settings",
    request: GlobalSettingsPutSchema,
    response: GlobalSettingsReadSchema,
  },

  promptGet: { method: "GET", path: "/api/prompts/:persona", response: PromptSchema },
  promptPut: {
    method: "PUT",
    path: "/api/prompts/:persona",
    request: PromptPutSchema,
    response: PromptSchema,
  },
  promptReset: { method: "POST", path: "/api/prompts/:persona/reset", response: PromptSchema },

  probePi: { method: "GET", path: "/api/onboarding/pi", response: PiProbeSchema },
  probeGhPrimary: { method: "GET", path: "/api/onboarding/gh/primary", response: ProbeSchema },
  probeGhReview: { method: "GET", path: "/api/onboarding/gh/review", response: ProbeSchema },
  reviewLoginStart: {
    method: "POST",
    path: "/api/onboarding/review-login/start",
    response: ReviewLoginStartSchema,
  },
  reviewLoginStatus: {
    method: "GET",
    path: "/api/onboarding/review-login/status",
    response: ReviewLoginStatusSchema,
  },

  updateCheck: { method: "GET", path: "/api/update", response: UpdateCheckSchema },
  updateApply: { method: "POST", path: "/api/update/apply", response: OkSchema },
} satisfies Record<string, RestEndpoint>;

export type RestEndpointName = keyof typeof restEndpoints;
