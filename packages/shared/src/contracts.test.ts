import { describe, expect, it } from "vitest";
import {
  GlobalSettingsPutSchema,
  GlobalSettingsReadSchema,
  GlobalSettingsSchema,
} from "./settings.js";
import { Personas, PersonaSchema } from "./persona.js";
import { ProjectCreateSchema, ProjectSettingsSchema } from "./project.js";
import { SessionSchema, SessionViewSchema } from "./session.js";
import { WorkerStates, WorkerStateSchema } from "./state.js";
import { PiProbeSchema, restEndpoints } from "./rest.js";
import { ProjectsChangedSchema, SessionsChangedSchema, WsClientMessageSchema, WsServerMessageSchema } from "./ws.js";

describe("persona", () => {
  it("accepts the four personas and nothing else", () => {
    expect([...Personas]).toEqual(["global", "orchestrator", "worker", "reviewer"]);
    expect(PersonaSchema.parse("worker")).toBe("worker");
    expect(() => PersonaSchema.parse("researcher")).toThrow();
  });
});

describe("worker state", () => {
  it("has exactly the eight spec states", () => {
    expect([...WorkerStates]).toEqual([
      "working",
      "ci",
      "fixing",
      "in_review",
      "addressing",
      "ready",
      "blocked",
      "done",
    ]);
    expect(() => WorkerStateSchema.parse("idle")).toThrow();
  });
});

describe("session", () => {
  const base = {
    id: "s1",
    persona: "worker",
    projectId: "p1",
    issueNumber: 42,
    tmuxSession: "pideck-s1",
    spawnedAt: "2025-01-01T00:00:00Z",
    model: null,
  };

  it("defaults watermarks on a fresh session", () => {
    const session = SessionSchema.parse(base);
    expect(session.fixAttempts).toBe(0);
    expect(session.lastPromptedHeadSha).toBeNull();
    expect(session.lastDeliveredIssueCommentId).toBeNull();
    expect(session.lastDeliveredPrCommentId).toBeNull();
    expect(session.lastDeliveredReviewId).toBeNull();
    expect(session.lastActivityAt).toBeNull();
  });

  it("rejects an unknown persona", () => {
    expect(() => SessionSchema.parse({ ...base, persona: "researcher" })).toThrow();
  });

  it("allows a null projectId for the global agent", () => {
    const session = SessionSchema.parse({
      ...base,
      persona: "global",
      projectId: null,
      tmuxSession: "global",
    });
    expect(session.projectId).toBeNull();
  });

  it("keeps optional issue and pr numbers absent for orchestrators", () => {
    const session = SessionSchema.parse({
      id: "s2",
      persona: "orchestrator",
      projectId: "p1",
      tmuxSession: "s",
      spawnedAt: "2025-01-01T00:00:00Z",
      model: null,
    });
    expect(session.issueNumber).toBeUndefined();
    expect(session.prNumber).toBeUndefined();
    expect(session.archivedAt).toBeUndefined();
  });
});

describe("session view", () => {
  const base = {
    id: "s1",
    persona: "worker",
    projectId: "p1",
    issueNumber: 42,
    tmuxSession: "s",
    spawnedAt: "2025-01-01T00:00:00Z",
    model: null,
  };

  it("pairs a session with a derived state and parent link", () => {
    const view = SessionViewSchema.parse({
      session: base,
      state: "fixing",
      status: "PR #7, attempt 2",
      parentSessionId: null,
      title: "Add rate limiting",
    });
    expect(view.state).toBe("fixing");
    expect(view.title).toBe("Add rate limiting");
    const reviewer = SessionViewSchema.parse({
      session: { ...base, persona: "reviewer", prNumber: 7 },
      state: "in_review",
      status: "re-review",
      parentSessionId: "s1",
      title: null,
    });
    expect(reviewer.parentSessionId).toBe("s1");
    expect(() =>
      SessionViewSchema.parse({
        session: base,
        state: "cooking",
        status: "",
        parentSessionId: null,
        title: null,
      }),
    ).toThrow();
  });

  it("allows a null state for sessions without worker states", () => {
    const view = SessionViewSchema.parse({
      session: { ...base, persona: "orchestrator" },
      state: null,
      status: "listening",
      parentSessionId: null,
      title: null,
    });
    expect(view.state).toBeNull();
  });
});

describe("project settings", () => {
  it("applies the spec defaults", () => {
    expect(ProjectSettingsSchema.parse({})).toEqual({
      workerConcurrency: 3,
      maxFixAttempts: 5,
      contextLimitPercent: 80,
      stallMinutes: 20,
      autoMerge: false,
    });
  });

  it("rejects out-of-range values", () => {
    expect(() => ProjectSettingsSchema.parse({ workerConcurrency: 0 })).toThrow();
    expect(() => ProjectSettingsSchema.parse({ contextLimitPercent: 101 })).toThrow();
    expect(() => ProjectSettingsSchema.parse({ stallMinutes: 1.5 })).toThrow();
  });
});

describe("project create", () => {
  it("accepts both onboarding modes and nothing else", () => {
    expect(ProjectCreateSchema.parse({ mode: "clone", repoUrl: "https://github.com/o/r" })).toEqual({
      mode: "clone",
      repoUrl: "https://github.com/o/r",
    });
    expect(
      ProjectCreateSchema.parse({ mode: "create", name: "my-api", private: true }),
    ).toEqual({ mode: "create", name: "my-api", private: true });
    expect(() => ProjectCreateSchema.parse({ mode: "clone" })).toThrow();
    expect(() => ProjectCreateSchema.parse({ mode: "create", name: "x" })).toThrow();
    expect(() => ProjectCreateSchema.parse({ repoUrl: "https://github.com/o/r" })).toThrow();
  });
});

describe("global settings", () => {
  it("loads without a review account, before onboarding completes", () => {
    const settings = GlobalSettingsSchema.parse({});
    expect(settings.reviewAccount).toBeNull();
    expect(settings.modelByPersona).toEqual({
      global: null,
      orchestrator: null,
      worker: null,
      reviewer: null,
    });
  });

  it("requires every persona key when provided", () => {
    expect(() =>
      GlobalSettingsSchema.parse({
        reviewAccount: null,
        modelByPersona: { global: null, orchestrator: null, worker: null },
      }),
    ).toThrow();
  });

  it("reads back a token presence flag, never the token", () => {
    const read = GlobalSettingsReadSchema.parse({
      reviewAccount: { username: "reviewer-bot", tokenSet: true },
      modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
    });
    expect(read.reviewAccount).toEqual({ username: "reviewer-bot", tokenSet: true });
    expect(JSON.stringify(read)).not.toContain("token\"");
    expect(
      GlobalSettingsReadSchema.parse({
        reviewAccount: null,
        modelByPersona: { global: null, orchestrator: null, worker: null, reviewer: null },
      }).reviewAccount,
    ).toBeNull();
  });

  it("lets a put omit the token to keep it and null to clear the account", () => {
    const keep = GlobalSettingsPutSchema.parse({
      reviewAccount: { username: "reviewer-bot" },
      modelByPersona: { global: null, orchestrator: null, worker: "m", reviewer: null },
    });
    expect(keep.reviewAccount).toEqual({ username: "reviewer-bot" });
    expect(keep.modelByPersona?.worker).toBe("m");
    expect(GlobalSettingsPutSchema.parse({ reviewAccount: null }).reviewAccount).toBeNull();
    expect(GlobalSettingsPutSchema.parse({}).reviewAccount).toBeUndefined();
    expect(() => GlobalSettingsPutSchema.parse({ reviewAccount: {} })).toThrow();
  });
});

describe("pi probe", () => {
  it("carries providers, models, and the default model", () => {
    const probe = PiProbeSchema.parse({
      ok: true,
      detail: "authenticated",
      providers: ["anthropic", "openai"],
      models: ["claude-x", "gpt-y"],
      defaultModel: "claude-x",
    });
    expect(probe.models).toHaveLength(2);
    expect(PiProbeSchema.parse({ ok: false, detail: "", providers: [], models: [], defaultModel: null }).defaultModel).toBeNull();
    expect(() => PiProbeSchema.parse({ ok: true, detail: "" })).toThrow();
  });
});

describe("rest endpoint map", () => {
  it("defines a response schema for every endpoint", () => {
    for (const [name, endpoint] of Object.entries(restEndpoints)) {
      expect(endpoint.response, name).toBeDefined();
      expect(endpoint.path, name).toMatch(/^\/api\//);
    }
  });

  it("maps settings, probes, and prompts as named in the spec", () => {
    expect(restEndpoints.projectSettingsPut).toMatchObject({
      method: "PUT",
      path: "/api/projects/:id/settings",
    });
    expect(restEndpoints.promptReset).toMatchObject({
      method: "POST",
      path: "/api/prompts/:persona/reset",
    });
    expect(restEndpoints.probeGhPrimary).toMatchObject({
      method: "GET",
      path: "/api/onboarding/gh/primary",
    });
    expect(restEndpoints.probeGhReview).toMatchObject({
      method: "GET",
      path: "/api/onboarding/gh/review",
    });
    expect(restEndpoints.updateApply.method).toBe("POST");
  });

  it("never exposes a write-only token in read responses", () => {
    expect(restEndpoints.globalSettingsGet.response).toBe(GlobalSettingsReadSchema);
    expect(restEndpoints.globalSettingsPut.request).toBe(GlobalSettingsPutSchema);
  });
});

describe("ws events", () => {
  const baseSession = {
    id: "s1",
    persona: "worker",
    projectId: "p1",
    issueNumber: 42,
    tmuxSession: "s",
    spawnedAt: "2025-01-01T00:00:00Z",
    model: null,
  };
  const view = {
    session: baseSession,
    state: "working",
    status: "implementing",
    parentSessionId: null,
    title: "Add rate limiting",
  };

  it("carries the daemon-wide session view list", () => {
    const event = SessionsChangedSchema.parse({
      type: "sessions.changed",
      sessions: [view],
    });
    expect(event.sessions).toHaveLength(1);
    expect("projectId" in event).toBe(false);
  });

  it("carries the daemon-wide project list", () => {
    const event = ProjectsChangedSchema.parse({
      type: "projects.changed",
      projects: [
        {
          id: "p1",
          name: "my-api",
          repoUrl: "https://github.com/acme/my-api",
          owner: "acme",
          repo: "my-api",
          defaultBranch: "main",
          path: "/repos/my-api",
        },
      ],
    });
    expect(event.projects).toHaveLength(1);
    expect(event.projects[0]!.name).toBe("my-api");
    expect(() => ProjectsChangedSchema.parse({ type: "projects.changed" })).toThrow();
  });

  it("covers the terminal stream protocol in both directions", () => {
    expect(
      WsClientMessageSchema.parse({ type: "terminal.attach", sessionId: "s1" }).type,
    ).toBe("terminal.attach");
    expect(
      WsClientMessageSchema.parse({
        type: "terminal.resize",
        sessionId: "s1",
        cols: 80,
        rows: 24,
      }).type,
    ).toBe("terminal.resize");
    expect(
      WsServerMessageSchema.parse({ type: "terminal.data", sessionId: "s1", data: "hi" }).type,
    ).toBe("terminal.data");
    expect(
      WsServerMessageSchema.parse({ type: "sessions.changed", sessions: [] }).type,
    ).toBe("sessions.changed");
    expect(
      WsServerMessageSchema.parse({ type: "projects.changed", projects: [] }).type,
    ).toBe("projects.changed");
    expect(() => WsClientMessageSchema.parse({ type: "terminal.attach" })).toThrow();
    expect(() =>
      WsServerMessageSchema.parse({ type: "terminal.detach", sessionId: "s1" }),
    ).toThrow();
  });
});
