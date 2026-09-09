/**
 * Agent-kind contract tests (docs/agent-kinds.md, issues #297/#300/#302):
 * the kind enum + fixed report routes, agent-kind session fields, and the
 * spawn-agent endpoint shape — split from index.test.ts (kiss max-lines
 * budget).
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_KIND_REPORT_TARGET,
  agentKindSchema,
  endpoints,
  formatPath,
  sessionSchema,
  spawnAgentRequestSchema,
  type EndpointRequest,
  type EndpointResponse,
  type Session,
  type SpawnAgentRequest,
} from "./index.js";

const NOW = "2025-06-01T12:00:00.000Z";

describe("domain: agent kinds (preset-prompt sessions, docs/agent-kinds.md)", () => {
  it("contracts the three kinds and their fixed report routes", () => {
    for (const kind of ["investigator", "devex-audit", "kiss-audit"] as const) {
      expect(agentKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(agentKindSchema.safeParse("researcher").success).toBe(false);
    // Investigator reports to the caller; audits report to the orchestrator.
    expect(AGENT_KIND_REPORT_TARGET).toEqual({
      investigator: "caller",
      "devex-audit": "project-orchestrator",
      "kiss-audit": "project-orchestrator",
    });
  });

  it("parses agent-kind sessions with kind, parent lineage, and sidebar name", () => {
    const kindSession = sessionSchema.parse({
      id: "s3",
      projectId: "p",
      role: "worker",
      tmuxSession: "pideck-p-worker-3",
      agentKind: "investigator",
      parentSessionId: "s1",
      name: "inv",
      workerId: null,
      createdAt: NOW,
    });
    expect(kindSession.agentKind).toBe("investigator");
    expect(kindSession.parentSessionId).toBe("s1");
    expect(kindSession.name).toBe("inv");
    expect(kindSession.workerId).toBeNull();
    // Unknown kinds are rejected; absent fields still parse (pre-#297 sessions).
    expect(sessionSchema.safeParse({ ...kindSession, agentKind: "researcher" }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...kindSession, name: "x".repeat(21) }).success).toBe(false);
    expect(sessionSchema.parse({ ...kindSession, agentKind: undefined, parentSessionId: undefined, name: undefined }).agentKind).toBeUndefined();
  });

  it("contracts the spawn-agent request and endpoint (issues #297/#300/#302)", () => {
    const request = spawnAgentRequestSchema.parse({ kind: "kiss-audit", name: "audit" });
    expect(request.question).toBeUndefined();
    expect(spawnAgentRequestSchema.safeParse({ kind: "researcher", name: "x" }).success).toBe(false);
    expect(spawnAgentRequestSchema.safeParse({ kind: "kiss-audit", name: "x".repeat(21) }).success).toBe(false);

    const endpoint = endpoints.spawnProjectAgent;
    expect(endpoint.method).toBe("POST");
    expect(endpoint.path).toBe("/api/projects/:projectId/spawn-agent");
    expect(formatPath("spawnProjectAgent", { projectId: "p" })).toBe("/api/projects/p/spawn-agent");
    expectTypeOf<EndpointRequest<"spawnProjectAgent">>().toEqualTypeOf<SpawnAgentRequest>();
    expectTypeOf<EndpointResponse<"spawnProjectAgent">>().toEqualTypeOf<Session>();
  });
});
