import { describe, expect, it } from "vitest";
import { GlobalSettingsSchema, maskToken } from "./settings.js";
import { Personas, PersonaSchema } from "./persona.js";
import { ProjectSettingsSchema } from "./project.js";
import { SessionSchema, SessionViewSchema } from "./session.js";
import { WorkerStates, WorkerStateSchema } from "./state.js";
import { restEndpoints } from "./rest.js";
import {
  SessionsChangedSchema,
  WsClientMessageSchema,
  WsServerMessageSchema,
} from "./ws.js";

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
  it("defaults watermarks on a fresh session", () => {
    const session = SessionSchema.parse({
      id: "s1",
      persona: "worker",
      projectId: "p1",
      issueNumber: 42,
      tmuxSession: "pideck-s1",
      spawnedAt: "2025-01-01T00:00:00Z",
      model: null,
    });
    expect(session.fixAttempts).toBe(0);
    expect(session.lastPromptedHeadSha).toBeNull();
    expect(session.lastDeliveredIssueCommentId).toBeNull();
    expect(session.lastDeliveredPrCommentId).toBeNull();
    expect(session.lastDeliveredReviewId).toBeNull();
    expect(session.lastActivityAt).toBeNull();
  });

  it("rejects an unknown persona", () => {
    expect(() =>
      SessionSchema.parse({
        id: "s1",
        persona: "researcher",
        projectId: "p1",
        tmuxSession: "s",
        spawnedAt: "2025-01-01T00:00:00Z",
        model: null,
      }),
    ).toThrow();
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
  it("pairs a session with a derived state and parent link", () => {
    const base = {
      id: "s1",
      persona: "worker",
      projectId: "p1",
      issueNumber: 42,
      tmuxSession: "s",
      spawnedAt: "2025-01-01T00:00:00Z",
      model: null,
    };
    const view = SessionViewSchema.parse({
      session: base,
      state: "fixing",
      status: "PR #7, attempt 2",
      parentSessionId: null,
    });
    expect(view.state).toBe("fixing");
    const reviewer = SessionViewSchema.parse({
      session: { ...base, persona: "reviewer", prNumber: 7 },
      state: "in_review",
      status: "re-review",
      parentSessionId: "s1",
    });
    expect(reviewer.parentSessionId).toBe("s1");
    expect(() =>
      SessionViewSchema.parse({
        session: base,
        state: "cooking",
        status: "",
        parentSessionId: null,
      }),
    ).toThrow();
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

describe("global settings", () => {
  it("defaults every persona model to null", () => {
    const settings = GlobalSettingsSchema.parse({
      reviewAccount: { username: "reviewer-bot", token: "tok" },
    });
    expect(settings.modelByPersona).toEqual({
      global: null,
      orchestrator: null,
      worker: null,
      reviewer: null,
    });
  });

  it("requires every persona key", () => {
    expect(() =>
      GlobalSettingsSchema.parse({
        reviewAccount: { username: "reviewer-bot", token: "tok" },
        modelByPersona: { global: null, orchestrator: null, worker: null },
      }),
    ).toThrow();
  });
});

describe("maskToken", () => {
  it("keeps only the last four characters", () => {
    expect(maskToken("ghp_abcdef1234")).toBe("••••1234");
  });

  it("masks an empty token to an empty string", () => {
    expect(maskToken("")).toBe("");
  });
});

describe("rest endpoint map", () => {
  it("defines a response schema for every endpoint", () => {
    for (const [name, endpoint] of Object.entries(restEndpoints)) {
      expect(endpoint.response, name).toBeDefined();
      expect(endpoint.path, name).toMatch(/^\/api\//);
    }
  });

  it("maps settings and prompts as named in the spec", () => {
    expect(restEndpoints.projectSettingsPut).toMatchObject({
      method: "PUT",
      path: "/api/projects/:id/settings",
    });
    expect(restEndpoints.promptReset).toMatchObject({
      method: "POST",
      path: "/api/prompts/:persona/reset",
    });
    expect(restEndpoints.updateApply.method).toBe("POST");
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

  it("carries the full session view list for a project", () => {
    const event = SessionsChangedSchema.parse({
      type: "sessions.changed",
      projectId: "p1",
      sessions: [
        {
          session: baseSession,
          state: "working",
          status: "implementing",
          parentSessionId: null,
        },
      ],
    });
    expect(event.sessions).toHaveLength(1);
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
      WsServerMessageSchema.parse({
        type: "sessions.changed",
        projectId: "p1",
        sessions: [],
      }).type,
    ).toBe("sessions.changed");
    expect(() => WsClientMessageSchema.parse({ type: "terminal.attach" })).toThrow();
    expect(() => WsServerMessageSchema.parse({ type: "terminal.detach", sessionId: "s1" })).toThrow();
  });
});
