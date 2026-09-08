/**
 * REST contract tests for `rest.ts`: the endpoint map, request/response
 * typing, path formatting, and the settings schema. Domain schemas and
 * websocket events live in `domain.test.ts` / `ws.test.ts`.
 */

import { describe, expect, expectTypeOf, it } from "vitest";
import {
  endpoints,
  formatPath,
  pullRequestDiffSchema,
  registerProjectRequestSchema,
  settingsSchema,
  type EndpointRequest,
  type EndpointResponse,
} from "./index.js";

describe("REST endpoint map", () => {
  it("covers projects CRUD/register, kanban, sessions, diffs, and settings", () => {
    const expected: Array<[string, string, string]> = [
      ["listProjects", "GET", "/api/projects"],
      ["registerProject", "POST", "/api/projects"],
      ["getProject", "GET", "/api/projects/:projectId"],
      ["updateProject", "PATCH", "/api/projects/:projectId"],
      ["deleteProject", "DELETE", "/api/projects/:projectId"],
      ["getProjectKanban", "GET", "/api/projects/:projectId/kanban"],
      ["listProjectSessions", "GET", "/api/projects/:projectId/sessions"],
      ["listProjectWorkers", "GET", "/api/projects/:projectId/workers"],
      ["ensureProjectOrchestrator", "POST", "/api/projects/:projectId/orchestrator"],
      ["listProjectPullRequests", "GET", "/api/projects/:projectId/pulls"],
      ["getPullRequestDiff", "GET", "/api/projects/:projectId/pulls/:prNumber/diff"],
      ["getSettings", "GET", "/api/settings"],
      ["updateSettings", "PUT", "/api/settings"],
    ];
    for (const [name, method, path] of expected) {
      const endpoint = endpoints[name as keyof typeof endpoints];
      expect(endpoint.method).toBe(method);
      expect(endpoint.path).toBe(path);
    }
  });

  it("derives request and response types from the schemas", () => {
    expectTypeOf<EndpointRequest<"registerProject">>().toMatchTypeOf<{ mode: "clone" | "create" }>();
    expectTypeOf<EndpointRequest<"getProject">>().toEqualTypeOf<undefined>();
    expectTypeOf<EndpointResponse<"getProjectKanban">>().toMatchTypeOf<{ projectId: string }>();
    expectTypeOf<EndpointResponse<"listProjectSessions">>().toMatchTypeOf<Array<{ role: string }>>();
  });

  it("formats paths with params", () => {
    expect(formatPath("getPullRequestDiff", { projectId: "pideck", prNumber: 42 })).toBe(
      "/api/projects/pideck/pulls/42/diff",
    );
    expect(formatPath("getProject", { projectId: "a b/c" })).toBe("/api/projects/a%20b%2Fc");
  });

  it("parses clone and create registration bodies", () => {
    const clone = registerProjectRequestSchema.parse({
      mode: "clone",
      repoUrl: "https://github.com/example/example",
    });
    expect(clone.mode).toBe("clone");

    const created = registerProjectRequestSchema.parse({ mode: "create", name: "new-repo" });
    if (created.mode !== "create") throw new Error("expected create mode");
    expect(created.isPrivate).toBe(true);

    expect(registerProjectRequestSchema.safeParse({ mode: "fork", name: "x" }).success).toBe(false);
  });

  it("validates settings with username, concurrency, and the pipeline toggles (issue #106)", () => {
    const settings = settingsSchema.parse({ autoAgentUsername: "eric", defaultWorkerConcurrency: 3 });
    expect(settings.defaultWorkerConcurrency).toBe(3);
    expect(settings.terminateOnMerge).toBe(true);
    expect(settings.autoFixCi).toBe(true);
    expect(settings.autoFixReviewComments).toBe(true);
    expect(settings.browserMergeNotifications).toBe(false);
    expect(settingsSchema.safeParse({ autoAgentUsername: "eric", defaultWorkerConcurrency: 0 }).success).toBe(false);
    expect(settingsSchema.parse({ autoAgentUsername: null, defaultWorkerConcurrency: 1, autoFixCi: false }).autoFixCi).toBe(false);
  });

  it("validates PR diff payloads", () => {
    const diff = pullRequestDiffSchema.parse({
      projectId: "p",
      prNumber: 7,
      headBranch: "feature",
      baseBranch: "main",
      files: [{ filename: "src/index.ts", status: "modified", additions: 10, deletions: 2 }],
      patch: "diff --git a/src/index.ts b/src/index.ts\n...",
    });
    expect(diff.files).toHaveLength(1);
    expect(pullRequestDiffSchema.safeParse({ ...diff, files: [{ ...diff.files[0], status: "moved" }] }).success).toBe(
      false,
    );
  });
});
