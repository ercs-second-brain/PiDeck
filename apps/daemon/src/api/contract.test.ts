/**
 * Contract tests: every endpoint in `packages/shared/src/rest.ts` must be
 * routed by the daemon, accept the contract's request shape, and return a
 * body the contract's response schema accepts — exercised over real HTTP.
 *
 * A shared-contract change without a matching daemon change fails here
 * (unrouted endpoint, 400/404 on the old request shape, or 500 on response
 * validation), which is exactly the "contract mismatches surface as test
 * failures" acceptance criterion.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  endpoints,
  formatPath,
  kanbanBoardSchema,
  projectSchema,
  pullRequestDiffSchema,
  pullRequestSchema,
  sessionSchema,
  settingsSchema,
  workerSchema,
  type EndpointName,
} from "@agentskiss/shared";

import { createDaemonServer } from "./server.js";
import { registerContractRoutes } from "./handlers.js";
import { Router } from "./router.js";
import { testDaemon, type TestDaemon } from "./testutil.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

const ghRoutes = {
  graphql: {
    "pullRequests(first: $first": {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 9,
              title: "Fix the flaky test",
              url: "https://github.com/o/r/pull/9",
              updatedAt: UPDATED_AT,
              author: { login: "auto-agent" },
              headRefName: "ao/fix-flaky",
              baseRefName: "main",
              headRefOid: "abc123",
              reviewDecision: null,
              commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            },
          ],
        },
      },
    },
    "issues(first: $first": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 5,
              title: "Fix the flaky test",
              url: "https://github.com/o/r/issues/5",
              updatedAt: UPDATED_AT,
              assignees: { nodes: [] },
              blockedBy: { nodes: [] },
            },
            {
              number: 7,
              title: "Assigned work",
              url: "https://github.com/o/r/issues/7",
              updatedAt: UPDATED_AT,
              assignees: { nodes: [{ login: "auto-agent" }] },
              blockedBy: { nodes: [{ number: 5, state: "OPEN", repository: { nameWithOwner: "o/r" } }] },
            },
          ],
        },
      },
    },
  },
  api: {
    "/repos/o/r/pulls/9": {
      number: 9,
      title: "Fix the flaky test",
      state: "open",
      merged_at: null,
      user: { login: "auto-agent" },
      head: { ref: "ao/fix-flaky", sha: "abc123" },
      base: { ref: "main" },
      html_url: "https://github.com/o/r/pull/9",
      updated_at: UPDATED_AT,
    },
  },
  prDiff: [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "+const b = 2;",
    "-const c = 3;",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+export {};",
    "",
  ].join("\n"),
};

let daemon: TestDaemon;
let server: Server;
let base: string;

beforeAll(async () => {
  daemon = testDaemon(ghRoutes);
  const created = createDaemonServer({ services: daemon.services, webDist: null });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
});

afterAll(async () => {
  daemon.services.hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
}

describe("contract endpoint coverage", () => {
  it("routes every endpoint in the shared endpoint map", () => {
    const { router } = createDaemonServer({ services: daemon.services, webDist: null });
    for (const [name, endpoint] of Object.entries(endpoints)) {
      const params = endpoint.path.includes(":prNumber") ? { projectId: "x", prNumber: 1 } : endpoint.path.includes(":projectId") ? { projectId: "x" } : {};
      const path = formatPath(name as EndpointName, params as never);
      expect(router.find(endpoint.method, path), `${endpoint.method} ${endpoint.path}`).toBeDefined();
    }
  });

  it("reports missing handlers as a 500 with the contract gap", async () => {
    const router = new Router();
    registerContractRoutes(router, {
      // every handler except getSettings missing → those routes must fail loudly
      getSettings: () => daemon.services.settings.get(),
    });
    const naked = createServer((req, res) => void router.dispatch(req, res));
    await new Promise<void>((resolve) => naked.listen(0, "127.0.0.1", resolve));
    const addr = naked.address();
    const nakedBase = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    try {
      const res = await fetch(`${nakedBase}${formatPath("getProject", { projectId: "p" })}`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("getProject");
    } finally {
      await new Promise<void>((resolve) => naked.close(() => resolve()));
    }
  });
});

describe("projects", () => {
  it("registers (clone), lists, gets, updates, and deletes a project", async () => {
    // registerProject
    const registered = await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/r" });
    expect(registered.status).toBe(200);
    const project = projectSchema.parse(registered.json);
    expect(project.id).toBe("o-r");
    expect(project.repoUrl).toBe("https://github.com/o/r");
    expect(project.settings).toEqual({ autoAgentUsername: null, workerConcurrency: 1 });
    expect(daemon.cloned.size).toBe(1);

    // duplicate registration → 409
    expect((await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/r" })).status).toBe(409);

    // listProjects
    const list = await api("GET", formatPath("listProjects", {}));
    expect(list.status).toBe(200);
    expect((list.json as unknown[]).map((p) => projectSchema.parse(p).id)).toContain("o-r");

    // getProject
    const got = await api("GET", formatPath("getProject", { projectId: "o-r" }));
    expect(got.status).toBe(200);
    expect(projectSchema.parse(got.json).id).toBe("o-r");

    // updateProject
    const updated = await api("PATCH", formatPath("updateProject", { projectId: "o-r" }), {
      settings: { autoAgentUsername: "auto-agent", workerConcurrency: 2 },
    });
    expect(updated.status).toBe(200);
    const updatedProject = projectSchema.parse(updated.json);
    expect(updatedProject.settings.autoAgentUsername).toBe("auto-agent");
    expect(updatedProject.settings.workerConcurrency).toBe(2);
    expect(updatedProject.updatedAt >= project.createdAt).toBe(true);

    // unknown project → 404
    expect((await api("GET", formatPath("getProject", { projectId: "nope" }))).status).toBe(404);

    // invalid request body → 400
    expect((await api("POST", "/api/projects", { mode: "clone", repoUrl: "not-a-url" })).status).toBe(400);

    // deleteProject → 204 no content
    const deleted = await api("DELETE", formatPath("deleteProject", { projectId: "o-r" }));
    expect(deleted.status).toBe(204);
    expect(deleted.json).toBeUndefined();
    expect((await api("GET", formatPath("getProject", { projectId: "o-r" }))).status).toBe(404);
  });
});

describe("kanban", () => {
  it("serves the derived board for a project", async () => {
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    const res = await api("GET", formatPath("getProjectKanban", { projectId: "o-r" }));
    expect(res.status).toBe(200);
    const board = kanbanBoardSchema.parse(res.json);
    expect(board.projectId).toBe("o-r");
    expect(board.columns.map((c) => c.column)).toEqual(["backlog", "in_progress", "in_review", "done"]);
    const byColumn = new Map(board.columns.map((c) => [c.column, c.cards.map((card) => card.number)]));
    expect(byColumn.get("backlog")).toEqual([5]); // unassigned open issue
    expect(byColumn.get("in_progress")).toEqual([7]); // assigned issue
    expect(byColumn.get("in_review")).toEqual([9]); // open PR with settled CI
    expect(byColumn.get("done")).toEqual([]);
  });
});

describe("sessions & workers", () => {
  it("lists sessions and workers for a project", async () => {
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/sx/rx" });
    const { worker } = await services.sessions.spawnWorker("sx-rx", { issueNumber: 5 });

    const sessions = await api("GET", formatPath("listProjectSessions", { projectId: "sx-rx" }));
    expect(sessions.status).toBe(200);
    const parsedSessions = (sessions.json as unknown[]).map((s) => sessionSchema.parse(s));
    expect(parsedSessions.map((s) => s.id)).toContain(worker.sessionId);
    expect(parsedSessions.every((s) => s.projectId === "sx-rx")).toBe(true);

    const workers = await api("GET", formatPath("listProjectWorkers", { projectId: "sx-rx" }));
    expect(workers.status).toBe(200);
    const parsedWorkers = (workers.json as unknown[]).map((w) => workerSchema.parse(w));
    expect(parsedWorkers.map((w) => w.id)).toContain(worker.id);
  });

  it("404s for unknown projects", async () => {
    expect((await api("GET", formatPath("listProjectSessions", { projectId: "ghost" }))).status).toBe(404);
    expect((await api("GET", formatPath("listProjectWorkers", { projectId: "ghost" }))).status).toBe(404);
  });
});

describe("pull requests", () => {
  it("lists enriched PRs and serves a PR diff", async () => {
    const { services } = daemon;
    if (services.projects.get("o-r") === undefined) {
      services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    }

    const pulls = await api("GET", formatPath("listProjectPullRequests", { projectId: "o-r" }));
    expect(pulls.status).toBe(200);
    const parsed = (pulls.json as unknown[]).map((p) => pullRequestSchema.parse(p));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.number).toBe(9);
    expect(parsed[0]?.ciStatus).toBe("success");
    expect(parsed[0]?.reviewState).toBe("none");

    const diff = await api("GET", formatPath("getPullRequestDiff", { projectId: "o-r", prNumber: 9 }));
    expect(diff.status).toBe(200);
    const parsedDiff = pullRequestDiffSchema.parse(diff.json);
    expect(parsedDiff.files).toHaveLength(2);
    expect(parsedDiff.files[0]).toMatchObject({ filename: "src/a.ts", status: "modified", additions: 1, deletions: 1 });
    expect(parsedDiff.files[1]).toMatchObject({ filename: "src/new.ts", status: "added", additions: 1, deletions: 0 });
    expect(parsedDiff.patch).toContain("diff --git a/src/a.ts");
    expect(parsedDiff.headBranch).toBe("ao/fix-flaky");
  });
});

describe("settings", () => {
  it("gets and updates daemon-wide settings", async () => {
    const got = await api("GET", endpoints.getSettings.path);
    expect(got.status).toBe(200);
    expect(settingsSchema.parse(got.json)).toEqual({ autoAgentUsername: null, defaultWorkerConcurrency: 1 });

    const updated = await api("PUT", endpoints.updateSettings.path, { autoAgentUsername: "auto-agent" });
    expect(updated.status).toBe(200);
    expect(settingsSchema.parse(updated.json)).toEqual({ autoAgentUsername: "auto-agent", defaultWorkerConcurrency: 1 });

    // invalid values → 400 (contract validation)
    expect((await api("PUT", endpoints.updateSettings.path, { defaultWorkerConcurrency: 99 })).status).toBe(400);

    // reset
    await api("PUT", endpoints.updateSettings.path, { autoAgentUsername: null });
  });
});

describe("CLI action routes", () => {
  it("exposes /api/status", async () => {
    const res = await api("GET", "/api/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, name: "agentskiss-daemon" });
  });

  it("spawns a worker with an issue, freeform via prompt, and validates the cap", async () => {
    const { services } = daemon;
    services.projects.register({ mode: "clone", repoUrl: "https://github.com/sp/rp", settings: { workerConcurrency: 2 } });

    const spawned = await api("POST", "/api/projects/sp-rp/spawn", { issueNumber: 5, name: "worker-one" });
    expect(spawned.status).toBe(201);
    expect(workerSchema.parse(spawned.json).issueNumber).toBe(5);

    // spawn without issue or prompt → 400
    expect((await api("POST", "/api/projects/sp-rp/spawn", { name: "worker-x" })).status).toBe(400);

    // freeform spawn (prompt only) → issueNumber 0 (documented freeform marker)
    const freeform = await api("POST", "/api/projects/sp-rp/spawn", { name: "freeform", prompt: "Investigate flaky CI" });
    expect(freeform.status).toBe(201);
    expect((freeform.json as { issueNumber: number }).issueNumber).toBe(0);

    // workers endpoint lists both, contract-valid: freeform (0) + issue-backed (5)
    const listed = await api("GET", formatPath("listProjectWorkers", { projectId: "sp-rp" }));
    expect(listed.status).toBe(200);
    const listedIssues = (listed.json as unknown[]).map((w) => workerSchema.parse(w).issueNumber).sort();
    expect(listedIssues).toEqual([0, 5]);

    // concurrency cap: 2 active workers (spawning/running) on a cap of 2
    const third = await api("POST", "/api/projects/sp-rp/spawn", { issueNumber: 8, name: "worker-three" });
    expect(third.status).toBe(409);
    expect((third.json as { error: string }).error).toContain("concurrency cap");
  });

  it("delivers messages to a session's pane and 404s unknown sessions", async () => {
    const { services } = daemon;
    const session = services.sessions.listSessions()[0];
    expect(session).toBeDefined();
    const res = await api("POST", `/api/sessions/${session?.id}/send`, { message: "hello agent" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });

    const missing = await api("POST", "/api/sessions/sess-missing/send", { message: "hi" });
    expect(missing.status).toBe(404);
  });
});
