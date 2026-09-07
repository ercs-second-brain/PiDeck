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
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  endpoints,
  formatPath,
  kanbanBoardSchema,
  piAuthSchema,
  projectSchema,
  pullRequestDiffSchema,
  pullRequestSchema,
  sessionSchema,
  settingsSchema,
  updateStatusResponseSchema,
  workerSchema,
  type EndpointName,
} from "@agentskiss/shared";

import { createDaemonServer } from "./server.js";
import { registerContractRoutes } from "./handlers.js";
import { Router } from "./router.js";
import { testDaemon, type TestDaemon } from "./testutil.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
/** Local source HEAD used by the /api/update contract test (issue #55). */
const LOCAL_SHA = "a".repeat(40);

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
              reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
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
  // /api/update (issue #55) with mock gh/git runners — the local checkout
  // matches the "upstream" head, so the shared daemon reports up to date.
  daemon = testDaemon(ghRoutes, {
    updateRepoUrl: "https://github.com/o/r",
    updateGh: async (args) => {
      if (args[0] === "api" && args[1] === "repos/o/r/commits/main") {
        return { stdout: JSON.stringify({ sha: LOCAL_SHA }), stderr: "" };
      }
      throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
    },
    updateGit: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${LOCAL_SHA}\n`, stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    },
  });
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
      const params = endpoint.path.includes(":prNumber")
        ? { projectId: "x", prNumber: 1 }
        : endpoint.path.includes(":workerId")
          ? { workerId: "x" }
          : endpoint.path.includes(":projectId")
            ? { projectId: "x" }
            : {};
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

  it("terminates a worker over HTTP: archived status, pane killed, record kept (issue #64)", async () => {
    const { services, tmux } = daemon;
    if (services.projects.get("term-rep") === undefined) {
      services.projects.register({ mode: "clone", repoUrl: "https://github.com/term/rep" });
    }
    const { session, worker } = await services.sessions.spawnWorker("term-rep", { issueNumber: 3 });
    expect(tmux.sessions.has(session.tmuxSession)).toBe(true);

    const res = await api("POST", formatPath("terminateWorker", { workerId: worker.id }));
    expect(res.status).toBe(200);
    const archived = workerSchema.parse(res.json);
    expect(archived.id).toBe(worker.id);
    expect(archived.status).toBe("archived");
    expect(tmux.sessions.has(session.tmuxSession)).toBe(false);

    // History preserved in the sessions/workers lists (archived, not gone).
    const listedSessions = await api("GET", formatPath("listProjectSessions", { projectId: "term-rep" }));
    expect((listedSessions.json as unknown[]).map((s) => sessionSchema.parse(s).id)).toContain(session.id);
    const listed = await api("GET", formatPath("listProjectWorkers", { projectId: "term-rep" }));
    expect((listed.json as unknown[]).map((w) => workerSchema.parse(w))).toContainEqual(archived);

    // Unknown worker → 404.
    expect((await api("POST", formatPath("terminateWorker", { workerId: "worker-ghost" }))).status).toBe(404);
  });
});

describe("orchestrator (issue #53)", () => {
  it("starts a project's orchestrator, is idempotent, and 404s unknown projects", async () => {
    const { services } = daemon;
    if (services.projects.get("orch-rep") === undefined) {
      services.projects.register({ mode: "clone", repoUrl: "https://github.com/orch/rep" });
    }

    const first = await api("POST", formatPath("ensureProjectOrchestrator", { projectId: "orch-rep" }));
    expect(first.status).toBe(200);
    const session = sessionSchema.parse(first.json);
    expect(session.projectId).toBe("orch-rep");
    expect(session.role).toBe("orchestrator");

    // Idempotent: a second call reuses the live orchestrator session.
    const again = await api("POST", formatPath("ensureProjectOrchestrator", { projectId: "orch-rep" }));
    expect(again.status).toBe(200);
    expect(sessionSchema.parse(again.json).id).toBe(session.id);

    // The orchestrator shows up in the project's session list.
    const sessions = await api("GET", formatPath("listProjectSessions", { projectId: "orch-rep" }));
    expect((sessions.json as unknown[]).map((s) => sessionSchema.parse(s).id)).toContain(session.id);

    // Unknown project → 404.
    const missing = await api("POST", formatPath("ensureProjectOrchestrator", { projectId: "ghost-orch" }));
    expect(missing.status).toBe(404);
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

describe("self-update (issues #55, #76)", () => {
  /** Dedicated daemon: the shared one accumulates pipeline auto-spawned
   * workers from the projects tests, which would make the gate counts
   * nondeterministic. Its `apply` spawn is recorded, never executed (the
   * real shim restarts the daemon, which no test can survive). */
  const updateSpawns: Array<{ file: string; args: readonly string[] }> = [];
  let ghCalls = 0;
  let upd: TestDaemon;
  let updServer: Server;
  let updBase: string;

  beforeAll(async () => {
    upd = testDaemon(ghRoutes, {
      updateRepoUrl: "https://github.com/o/r",
      updateGh: async (args) => {
        ghCalls += 1;
        if (args[0] === "api" && args[1] === "repos/o/r/commits/main") return { stdout: JSON.stringify({ sha: LOCAL_SHA }), stderr: "" };
        throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
      },
      updateGit: async (args) => {
        if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${LOCAL_SHA}\n`, stderr: "" };
        throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
      },
      updateSpawn: (file, args) => {
        updateSpawns.push({ file, args });
        return { unref() {} };
      },
    });
    mkdirSync(path.join(upd.stateDir, "bin"), { recursive: true });
    writeFileSync(path.join(upd.stateDir, "bin", "agentskiss"), "#!/bin/sh\n");
    const created = createDaemonServer({ services: upd.services, webDist: null });
    updServer = created.server;
    await new Promise<void>((resolve) => updServer.listen(0, "127.0.0.1", resolve));
    const addr = updServer.address();
    updBase = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterAll(async () => {
    upd.services.hub.close();
    await new Promise<void>((resolve) => updServer.close(() => resolve()));
  });

  async function updApi(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${updBase}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
  }

  it("exposes the update status (plus the active-worker gate count) through the contract endpoint", async () => {
    const res = await updApi("GET", endpoints.getUpdateStatus.path);
    expect(res.status).toBe(200);
    // runningSha (issue #89): the build the answering daemon runs — the banner resolves when it equals the target SHA.
    expect(updateStatusResponseSchema.parse(res.json)).toMatchObject({
      repo: "o/r", ref: "main", localSha: LOCAL_SHA, remoteSha: LOCAL_SHA, runningSha: LOCAL_SHA, applyProgress: null,
      updateAvailable: false, error: null, activeWorkers: 0,
    });
  });

  it("serves repeat GETs from the ~5 min cache but refresh=1 forces a re-check (issue #82)", async () => {
    const before = ghCalls;
    await updApi("GET", endpoints.getUpdateStatus.path); // cached from the previous test
    expect(ghCalls).toBe(before);
    const res = await updApi("GET", `${endpoints.getUpdateStatus.path}?refresh=1`); // bypasses the cache
    expect(res.status).toBe(200);
    expect(ghCalls).toBe(before + 1);
  });

  it("applies when idle: spawns the installed shim detached and returns immediately", async () => {
    const res = await updApi("POST", endpoints.applyUpdate.path);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    expect(updateSpawns).toEqual([{ file: path.join(upd.stateDir, "bin", "agentskiss"), args: ["update"] }]);
  });

  it("rejects the apply server-side while any worker is active (issue #76)", async () => {
    await updApi("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/sp/gate" });
    const spawned = await updApi("POST", "/api/projects/sp-gate/spawn", { issueNumber: 1, name: "gater" });
    expect(spawned.status).toBe(201);
    const res = await updApi("POST", endpoints.applyUpdate.path);
    expect(res.status).toBe(409);
    expect((res.json as { error: string }).error).toMatch(/still active/);
    expect((res.json as { error: string }).error).toMatch(/every agent is idle/);
  });
});

describe("CLI action routes", () => {
  it("exposes /api/status with the pi auth fields (issue #57)", async () => {
    const res = await api("GET", "/api/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true, name: "agentskiss-daemon", piReady: true });
    expect((res.json as { piProviders: unknown }).piProviders).toBeInstanceOf(Array);
  });

  it("exposes /api/pi-auth with the shared PiAuth shape (issue #57)", async () => {
    const res = await api("GET", "/api/pi-auth");
    expect(res.status).toBe(200);
    const parsed = piAuthSchema.parse(res.json);
    expect(parsed.ready).toBe(true);
    expect(parsed.providers.length).toBeGreaterThan(0);
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
