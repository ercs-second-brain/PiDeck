/**
 * Contract tests: every endpoint in `packages/shared/src/rest.ts` must be
 * routed by the daemon, accept the contract's request shape, and return a
 * body the contract's response schema accepts — exercised over real HTTP.
 *
 * A shared-contract change without a matching daemon change fails here
 * (unrouted endpoint, 400/404 on the old request shape, or 500 on response
 * validation), which is exactly the "contract mismatches surface as test
 * failures" acceptance criterion.
 *
 * Split by endpoint theme (shared fixtures in `contract-fixtures.ts`):
 * settings, self-update, and the CLI action routes live in their own
 * `contract-*.test.ts` files.
 */

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  endpoints,
  formatPath,
  kanbanBoardSchema,
  projectSchema,
  pullRequestDiffSchema,
  pullRequestSchema,
  sessionSchema,
  workerFilesChangedSchema,
  workerSchema,
  type EndpointName,
} from "@pideck/shared";

import { createDaemonServer } from "./server.js";
import { registerContractRoutes } from "./handlers.js";
import { Router } from "./router.js";
import { startContractServer, type ContractServer } from "./contract-fixtures.js";

let server: ContractServer;
let daemon: ContractServer["daemon"];
let api: ContractServer["api"];

beforeAll(async () => {
  // /api/update (issue #55) with mock gh/git runners — the local checkout
  // matches the "upstream" head, so the shared daemon reports up to date.
  server = await startContractServer({
    updateRepoUrl: "https://github.com/o/r",
    updateGh: async (args) => {
      if (args[0] === "api" && args[1] === "repos/o/r/commits/main") {
        return { stdout: JSON.stringify({ sha: "a".repeat(40) }), stderr: "" };
      }
      throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
    },
    updateGit: async (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${"a".repeat(40)}\n`, stderr: "" };
      throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
    },
  });
  daemon = server.daemon;
  api = server.api;
});

afterAll(async () => {
  await server?.close();
});

describe("contract endpoint coverage", () => {
  it("routes every endpoint in the shared endpoint map", () => {
    const { router } = createDaemonServer({ services: daemon.services, webDist: null });
    for (const [name, endpoint] of Object.entries(endpoints)) {
      const params = endpoint.path.includes(":prNumber")
        ? { projectId: "x", prNumber: 1 }
        : endpoint.path.includes(":workerId")
          ? { workerId: "x" }
          : endpoint.path.includes(":sessionId")
            ? { sessionId: "x" }
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

  it("clears the worker concurrency cap when the settings UI sends null (issue #168)", async () => {
    // Register with a capped project (the daemon default caps new projects).
    await api("POST", "/api/projects", { mode: "clone", repoUrl: "https://github.com/o/clear" });
    const capped = projectSchema.parse((await api("GET", formatPath("getProject", { projectId: "o-clear" }))).json);
    expect(capped.settings.workerConcurrency).toBe(1);

    // Empty field → the UI sends `settings.workerConcurrency: null`.
    const cleared = await api("PATCH", formatPath("updateProject", { projectId: "o-clear" }), {
      settings: { autoAgentUsername: null, workerConcurrency: null },
    });
    expect(cleared.status).toBe(200);
    const clearedProject = projectSchema.parse(cleared.json);
    // Null is normalized to unset: the cap is gone, not silently reverted.
    expect(clearedProject.settings.workerConcurrency).toBeUndefined();
    // Read-back over GET agrees — the field reads back empty for unbounded.
    const reread = projectSchema.parse((await api("GET", formatPath("getProject", { projectId: "o-clear" }))).json);
    expect(reread.settings.workerConcurrency).toBeUndefined();

    // A field omitted from the patch still means "untouched" (keep the cap).
    await api("PATCH", formatPath("updateProject", { projectId: "o-clear" }), { settings: { workerConcurrency: 3 } });
    const untouched = await api("PATCH", formatPath("updateProject", { projectId: "o-clear" }), {
      settings: { autoAgentUsername: "auto-agent" },
    });
    expect(projectSchema.parse(untouched.json).settings.workerConcurrency).toBe(3);
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

  it("relaunches a dead session over HTTP: same identity, pane recreated (issue #117)", async () => {
    const { services, tmux } = daemon;
    if (services.projects.get("relaunch-rep") === undefined) {
      services.projects.register({ mode: "clone", repoUrl: "https://github.com/relaunch/rep" });
    }
    const { session, worker } = await services.sessions.spawnWorker("relaunch-rep", { issueNumber: 8 });
    await services.sessions.updateWorkerStatus(worker.id, "stopped", "pane died");
    tmux.sessions.delete(session.tmuxSession); // simulate the pane dying
    expect(tmux.sessions.has(session.tmuxSession)).toBe(false);

    // Capture hub broadcasts for the assertion below.
    const hubBroadcasts: unknown[] = [];
    const originalBroadcast = services.hub.broadcast.bind(services.hub);
    services.hub.broadcast = ((event: unknown) => {
      hubBroadcasts.push(event);
      return originalBroadcast(event as Parameters<typeof originalBroadcast>[0]);
    }) as typeof services.hub.broadcast;

    const res = await api("POST", formatPath("relaunchSession", { sessionId: session.id }));
    expect(res.status).toBe(200);
    const relaunched = sessionSchema.parse(res.json);
    expect(relaunched.id).toBe(session.id); // identity preserved
    expect(tmux.sessions.has(session.tmuxSession)).toBe(true); // pane recreated

    // The worker bump is announced on the hub for live sidebars.
    expect(hubBroadcasts).toContainEqual(
      expect.objectContaining({ type: "worker.status.changed", workerId: worker.id, status: "running" }),
    );

    // Unknown session → 404; archived worker → 409 (history, not a pane).
    expect((await api("POST", formatPath("relaunchSession", { sessionId: "sess-ghost" }))).status).toBe(404);
    await services.sessions.archiveWorker(worker.id);
    expect((await api("POST", formatPath("relaunchSession", { sessionId: session.id }))).status).toBe(409);
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

describe("worker files changed (issue #126)", () => {
  it("serves a PR-backed worker's files and 404s unknown workers", async () => {
    const { services } = daemon;
    if (services.projects.get("o-r") === undefined) {
      services.projects.register({ mode: "clone", repoUrl: "https://github.com/o/r" });
    }
    const { worker } = await services.sessions.spawnWorker("o-r", { issueNumber: 5 });
    services.sessions.setWorkerPr(worker.id, 9);

    const res = await api("GET", formatPath("getWorkerFilesChanged", { workerId: worker.id }));
    expect(res.status).toBe(200);
    const parsed = workerFilesChangedSchema.parse(res.json);
    expect(parsed.workerId).toBe(worker.id);
    expect(parsed.projectId).toBe("o-r");
    expect(parsed.source).toBe("pr");
    expect(parsed.prNumber).toBe(9);
    expect(parsed.headBranch).toBe("ao/fix-flaky");
    expect(parsed.baseBranch).toBe("main");
    expect(parsed.files[0]).toMatchObject({ filename: "src/a.ts", status: "modified" });
    expect(parsed.patch).toContain("diff --git a/src/a.ts");

    // Unknown worker → 404.
    expect((await api("GET", formatPath("getWorkerFilesChanged", { workerId: "worker-ghost" }))).status).toBe(404);
  });
});
