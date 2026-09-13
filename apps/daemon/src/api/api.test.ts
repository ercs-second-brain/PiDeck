import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  restEndpoints,
  ProjectsChangedSchema,
  SessionsChangedSchema,
  type Project,
  type SessionView,
} from "@pideck/shared";
import { serve, type DaemonServer } from "./server.js";
import { makeDeps, sessionRecord } from "./testing.js";
import { PI_TRANSCRIPT_JSONL } from "../sessions/testFixture.js";
import { FakeTmux } from "../sessions/testing/fakeTmux.js";

let daemons: DaemonServer[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const daemon of daemons) void daemon.close();
  daemons = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

async function startDaemon(options: { webDistDir?: string | null } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "pideck-api-"));
  dirs.push(stateDir);
  const tmux = new FakeTmux();
  const deps = makeDeps(stateDir, tmux);
  const daemon = await serve(deps, {
    host: "127.0.0.1",
    port: 0,
    webDistDir: options.webDistDir ?? null,
    pollMs: 20,
    debounceMs: 10,
    heartbeatMs: 0,
  });
  daemons.push(daemon);
  return { daemon, deps, tmux, base: `http://127.0.0.1:${daemon.port}` };
}

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/** Round-trips a response body through its endpoint's response schema. */
function validate<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  return schema.parse(body) as z.output<Schema>;
}

function addProject(base: string): Promise<{ status: number; body: unknown }> {
  return call(base, "POST", "/api/projects", {
    mode: "clone",
    repoUrl: join(tmpdir(), "pideck-src", "acme", "widget"),
  });
}

describe("REST contract", () => {
  it("answers status and round-trips its schema", async () => {
    const { base } = await startDaemon();
    const res = await call(base, "GET", "/api/status");
    expect(res.status).toBe(200);
    const status = validate(restEndpoints["status"].response, res.body);
    expect(status.version).toBe("0.0.0-test");
    expect(status.piReady).toBe(true);
    expect(status.ghReady).toBe(true);
    expect(status.pollIntervalSeconds).toBe(30);
    expect(status.github).toEqual({ throttledUntil: null, lastError: null });
  });

  it("caches the status probes for 30 s", async () => {
    const { base, deps } = await startDaemon();
    const basePi = deps.pi;
    let piCalls = 0;
    deps.pi = () => {
      piCalls++;
      return basePi();
    };
    await call(base, "GET", "/api/status");
    await call(base, "GET", "/api/status");
    expect(piCalls).toBe(1);
  });

  it("creates, lists, gets and deletes projects", async () => {
    const { base } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    expect(project.owner).toBe("acme");
    expect(project.defaultBranch).toBe("main");

    const list = await call(base, "GET", "/api/projects");
    expect(validate(restEndpoints["projectList"].response, list.body)).toHaveLength(1);

    const got = await call(base, "GET", `/api/projects/${project.id}`);
    expect(validate(restEndpoints["projectGet"].response, got.body).id).toBe(project.id);

    const deleted = await call(base, "DELETE", `/api/projects/${project.id}`);
    expect(validate(restEndpoints["projectDelete"].response, deleted.body)).toEqual({ ok: true });
    expect((await call(base, "GET", `/api/projects/${project.id}`)).status).toBe(404);
  });

  it("reads and writes project settings", async () => {
    const { base } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);

    const got = await call(base, "GET", `/api/projects/${project.id}/settings`);
    const settings = validate(restEndpoints["projectSettingsGet"].response, got.body);

    const put = await call(base, "PUT", `/api/projects/${project.id}/settings`, {
      ...settings,
      workerConcurrency: 5,
    });
    expect(validate(restEndpoints["projectSettingsPut"].response, put.body).workerConcurrency).toBe(5);
  });

  it("lists all sessions and per project as SessionView[]", async () => {
    const { base, deps } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const worker = sessionRecord({ persona: "worker", projectId: project.id, issueNumber: 7 });
    const orchestrator = sessionRecord({ persona: "orchestrator", projectId: project.id });
    deps.registry.add(worker);
    deps.registry.add(orchestrator);

    const all = await call(base, "GET", "/api/sessions");
    const views: SessionView[] = validate(restEndpoints["sessionList"].response, all.body);
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.state)).toEqual(["working", null]);
    expect(views.find((v) => v.session.id === worker.id)?.status).toBe("working on #7");
    expect(views.find((v) => v.session.id === orchestrator.id)?.status).toBe("orchestrator");
    expect(views.every((v) => v.reviewAccess === null)).toBe(true);

    const perProject = await call(base, "GET", `/api/projects/${project.id}/sessions`);
    expect(validate(restEndpoints["projectSessionList"].response, perProject.body)).toHaveLength(2);
    expect((await call(base, "GET", "/api/projects/nope/sessions")).status).toBe(404);
  });

  it("flags a session as active while its pi agent is mid-turn", async () => {
    const { base, deps, tmux } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const worker = sessionRecord({ persona: "worker", projectId: project.id, issueNumber: 7 });
    deps.registry.add(worker);
    tmux.createSession(worker.tmuxSession);
    const dir = join(deps.stateDir, "pi-sessions", worker.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-01-01T00-00-00-000Z_0000.jsonl");
    const write = (lines: string[]) => writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const now = () => new Date().toISOString();
    const list = async (): Promise<SessionView> => {
      const views: SessionView[] = validate(
        restEndpoints["sessionList"].response,
        (await call(base, "GET", "/api/sessions")).body,
      );
      return views.find((v) => v.session.id === worker.id)!;
    };

    // No transcript yet — idle.
    expect((await list()).active).toBe(false);

    write([
      JSON.stringify({ type: "message", timestamp: now(), message: { role: "assistant", content: [], stopReason: "toolUse" } }),
    ]);
    expect((await list()).active).toBe(true);

    // A tool call running for an hour still reads as working — shape, not age.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    write([
      JSON.stringify({ type: "message", timestamp: hourAgo, message: { role: "assistant", content: [], stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", timestamp: hourAgo, message: { role: "toolResult", content: [] } }),
    ]);
    expect((await list()).active).toBe(true);

    write([
      JSON.stringify({ type: "message", timestamp: now(), message: { role: "assistant", content: [], stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", timestamp: now(), message: { role: "assistant", content: [], stopReason: "stop" } }),
    ]);
    expect((await list()).active).toBe(false);
  });

  it("reads a dead pane as idle even while its transcript is mid-turn", async () => {
    const { base, deps, tmux } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const worker = sessionRecord({ persona: "worker", projectId: project.id, issueNumber: 7 });
    deps.registry.add(worker);
    tmux.createSession(worker.tmuxSession);
    const dir = join(deps.stateDir, "pi-sessions", worker.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "2026-01-01T00-00-00-000Z_0000.jsonl");
    const message = (role: string, stopReason?: string): string =>
      JSON.stringify({
        type: "message",
        timestamp: new Date().toISOString(),
        message: { role, content: [], ...(stopReason === undefined ? {} : { stopReason }) },
      });
    writeFileSync(file, `${message("assistant", "toolUse")}\n`, "utf8");
    const list = async (): Promise<SessionView> => {
      const views: SessionView[] = validate(
        restEndpoints["sessionList"].response,
        (await call(base, "GET", "/api/sessions")).body,
      );
      return views.find((v) => v.session.id === worker.id)!;
    };

    expect((await list()).active).toBe(true);

    // The pane persists (remain-on-exit) but its payload is gone.
    tmux.exitPayload(worker.tmuxSession);
    await list();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await list()).active).toBe(false);

    // A pane that vanished entirely reads idle too.
    tmux.killSession(worker.tmuxSession);
    await list();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await list()).active).toBe(false);
  });

  it("carries the project's review-access failure on its session views", async () => {
    const { base, deps } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const worker = sessionRecord({ persona: "worker", projectId: project.id, issueNumber: 7 });
    deps.registry.add(worker);
    deps.reconcilerFacts = (projectId) =>
      projectId === project.id
        ? { issues: [], prs: [], primaryLogin: "acme", reviewAccess: "review account has no access to acme/widget" }
        : null;

    const views: SessionView[] = validate(
      restEndpoints["projectSessionList"].response,
      (await call(base, "GET", `/api/projects/${project.id}/sessions`)).body,
    );
    expect(views[0]!.reviewAccess).toBe("review account has no access to acme/widget");
  });

  it("derives worker state, title and reviewer parent from the reconciler's facts", async () => {
    const { base, deps } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const worker = sessionRecord({
      persona: "worker",
      projectId: project.id,
      issueNumber: 7,
      prNumber: 11,
      lastPromptedHeadSha: "sha-1",
    });
    const reviewer = sessionRecord({ persona: "reviewer", projectId: project.id, prNumber: 11 });
    deps.registry.add(worker);
    deps.registry.add(reviewer);
    deps.reconcilerFacts = (projectId) =>
      projectId === project.id
        ? {
            issues: [
              {
                number: 7,
                title: "Add rate limiting",
                url: `https://github.com/acme/widget/issues/7`,
                assignees: ["acme"],
                openBlockers: 0,
                comments: [],
              },
            ],
            prs: [
              {
                number: 11,
                headBranch: "pideck/issue-7",
                headSha: "sha-1",
                mergeable: "MERGEABLE",
                reviewDecision: "APPROVED",
                ciStatus: "ok",
                failingChecks: [],
                green: true,
                issueNumber: 7,
                reviews: [],
                reviewComments: [],
                prComments: [],
              },
            ],
            primaryLogin: "acme",
          }
        : null;

    const views: SessionView[] = validate(
      restEndpoints["sessionList"].response,
      (await call(base, "GET", "/api/sessions")).body,
    );
    const workerView = views.find((v) => v.session.id === worker.id)!;
    const reviewerView = views.find((v) => v.session.id === reviewer.id)!;
    expect(workerView.state).toBe("ready");
    expect(workerView.status).toBe("approved and green, PR #11");
    expect(workerView.title).toBe("Add rate limiting");
    expect(reviewerView.state).toBe("in_review");
    expect(reviewerView.parentSessionId).toBe(worker.id);
    expect(reviewerView.title).toBe("Add rate limiting");
  });

  it("nests an archived reviewer under the newest archived worker for its PR", async () => {
    const { base, deps } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    const olderWorker = sessionRecord({
      persona: "worker",
      id: "older",
      projectId: project.id,
      issueNumber: 7,
      prNumber: 11,
      spawnedAt: "2024-01-01T00:00:00.000Z",
      archivedAt: "2024-01-02T00:00:00.000Z",
    });
    const newerWorker = sessionRecord({
      persona: "worker",
      id: "newer",
      projectId: project.id,
      issueNumber: 7,
      prNumber: 11,
      spawnedAt: "2024-01-03T00:00:00.000Z",
      archivedAt: "2024-01-04T00:00:00.000Z",
    });
    const reviewer = sessionRecord({ persona: "reviewer", projectId: project.id, prNumber: 11 });
    deps.registry.add(olderWorker);
    deps.registry.add(newerWorker);
    deps.registry.add(reviewer);

    const views: SessionView[] = validate(
      restEndpoints["projectSessionList"].response,
      (await call(base, "GET", `/api/projects/${project.id}/sessions`)).body,
    );
    const reviewerView = views.find((v) => v.session.id === reviewer.id)!;
    expect(reviewerView.parentSessionId).toBe(newerWorker.id);
  });

  it("sends a line into the pane and rejects unknown or archived sessions", async () => {
    const { base, deps, tmux } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    tmux.createSession(worker.tmuxSession);

    const sent = await call(base, "POST", `/api/sessions/${worker.id}/send`, { text: "hello" });
    expect(validate(restEndpoints["sessionSend"].response, sent.body)).toEqual({ ok: true });
    expect(tmux.sent).toEqual([{ session: worker.tmuxSession, text: "hello" }]);

    expect(
      (await call(base, "POST", "/api/sessions/nope/send", { text: "hello" })).status,
    ).toBe(404);

    deps.registry.archive(worker.id);
    expect(
      (await call(base, "POST", `/api/sessions/${worker.id}/send`, { text: "x" })).status,
    ).toBe(409);
  });

  it("renames a session and rejects unknown or empty labels", async () => {
    const { base, deps } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);

    const res = await call(base, "PATCH", `/api/sessions/${worker.id}`, { label: "Rate limiting" });
    const view = validate(restEndpoints["sessionLabel"].response, res.body);
    expect(view.session.label).toBe("Rate limiting");
    expect(deps.registry.get(worker.id)?.label).toBe("Rate limiting");

    expect((await call(base, "PATCH", "/api/sessions/nope", { label: "x" })).status).toBe(404);
    expect((await call(base, "PATCH", `/api/sessions/${worker.id}`, { label: "" })).status).toBe(400);
  });

  it("terminates a session: archives, kills the pane, writes the log", async () => {
    const { base, deps, tmux } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    tmux.createSession(worker.tmuxSession);

    const res = await call(base, "POST", `/api/sessions/${worker.id}/terminate`);
    expect(validate(restEndpoints["sessionTerminate"].response, res.body)).toEqual({ ok: true });
    expect(deps.registry.get(worker.id)?.archivedAt).toBeDefined();
    expect(tmux.killed).toContain(worker.tmuxSession);

    const log = await call(base, "GET", `/api/sessions/${worker.id}/log`);
    expect(validate(restEndpoints["sessionLog"].response, log.body).log).toBe(
      "pane scrollback\n",
    );
    expect((await call(base, "GET", "/api/sessions/nope/log")).status).toBe(404);
  });

  it("serves a session's trace entries and pi transcript path", async () => {
    const { base, deps } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    deps.trace.append(worker.id, { at: "2026-01-01T00:00:00Z", kind: "spawn", detail: "spawned worker for issue #7" });
    deps.trace.append(worker.id, { at: "2026-01-01T00:01:00Z", kind: "delivery", text: "fix CI on PR #11" });
    mkdirSync(join(deps.stateDir, "pi-sessions", worker.id), { recursive: true });
    writeFileSync(join(deps.stateDir, "pi-sessions", worker.id, "pi.jsonl"), "{}\n");

    const res = await call(base, "GET", `/api/sessions/${worker.id}/trace`);
    expect(res.status).toBe(200);
    const trace = validate(restEndpoints["sessionTrace"].response, res.body);
    expect(trace.entries).toHaveLength(2);
    expect(trace.entries[0]).toMatchObject({ kind: "spawn", detail: "spawned worker for issue #7" });
    expect(trace.entries[1]).toMatchObject({ kind: "delivery", text: "fix CI on PR #11" });
    expect(trace.transcriptPath?.endsWith("pi.jsonl")).toBe(true);

    expect((await call(base, "GET", "/api/sessions/nope/trace")).status).toBe(404);
  });

  it("serves a session's parsed pi transcript and 404s unknown sessions", async () => {
    const { base, deps } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    const dir = join(deps.stateDir, "pi-sessions", worker.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_0000.jsonl"), PI_TRANSCRIPT_JSONL, "utf8");

    const res = await call(base, "GET", `/api/sessions/${worker.id}/transcript`);
    expect(res.status).toBe(200);
    const transcript = validate(restEndpoints["sessionTranscript"].response, res.body);
    expect(transcript.entries.map((e) => e.role)).toEqual(["user", "tool", "assistant"]);
    expect(transcript.entries[0]).toMatchObject({ at: "2026-01-01T00:00:01.000Z", text: "Run the shell command 'echo hi' and then stop." });
    expect(transcript.entries[1]).toMatchObject({ role: "tool", text: 'bash({"command":"echo hi"})' });

    // An archived session keeps serving its transcript.
    deps.registry.archive(worker.id);
    expect((await call(base, "GET", `/api/sessions/${worker.id}/transcript`)).status).toBe(200);
    // No transcript file: empty entries, not an error.
    const fresh = sessionRecord();
    deps.registry.add(fresh);
    const empty = validate(
      restEndpoints["sessionTranscript"].response,
      (await call(base, "GET", `/api/sessions/${fresh.id}/transcript`)).body,
    );
    expect(empty.entries).toEqual([]);

    expect((await call(base, "GET", "/api/sessions/nope/transcript")).status).toBe(404);
  });

  it("masks the review token in global settings", async () => {
    const { base } = await startDaemon();
    const initial = validate(restEndpoints["globalSettingsGet"].response, (await call(base, "GET", "/api/settings")).body);
    expect(initial.reviewAccount).toBeNull();

    const stored = validate(
      restEndpoints["globalSettingsPut"].response,
      (
        await call(base, "PUT", "/api/settings", {
          reviewAccount: { username: "reviewer", token: "ghp_secret" },
          modelByPersona: { global: null, orchestrator: "m1", worker: null, reviewer: null },
        })
      ).body,
    );
    expect(stored).toEqual({
      reviewAccount: { username: "reviewer", tokenSet: true },
      modelByPersona: { global: null, orchestrator: "m1", worker: null, reviewer: null },
    });
    expect(JSON.stringify(stored)).not.toContain("ghp_secret");
  });

  it("rejects clearing the review account", async () => {
    const { base } = await startDaemon();
    const res = await call(base, "PUT", "/api/settings", { reviewAccount: null });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain("the review account is required");
  });

  it("reads, edits and resets persona prompts", async () => {
    const { base } = await startDaemon();
    const shipped = validate(restEndpoints["promptGet"].response, (await call(base, "GET", "/api/prompts/worker")).body);
    expect(shipped.edited).toBe(false);
    expect(shipped.prompt.length).toBeGreaterThan(0);

    const put = await call(base, "PUT", "/api/prompts/worker", { prompt: "custom prompt" });
    expect(validate(restEndpoints["promptPut"].response, put.body)).toMatchObject({
      persona: "worker",
      prompt: "custom prompt",
      edited: true,
    });

    const reset = await call(base, "POST", "/api/prompts/worker/reset");
    expect(validate(restEndpoints["promptReset"].response, reset.body).edited).toBe(false);
    expect((await call(base, "GET", "/api/prompts/other")).status).toBe(404);
  });

  it("answers onboarding probes", async () => {
    const { base } = await startDaemon();
    const pi = validate(restEndpoints["probePi"].response, (await call(base, "GET", "/api/onboarding/pi")).body);
    expect(pi).toMatchObject({
      ok: true,
      providers: ["openrouter"],
      models: ["a/b", "c/d"],
      defaultModel: "a/b",
    });
    const primary = validate(
      restEndpoints["probeGhPrimary"].response,
      (await call(base, "GET", "/api/onboarding/gh/primary")).body,
    );
    expect(primary.detail).toBe("logged in as primary");
    const review = validate(
      restEndpoints["probeGhReview"].response,
      (await call(base, "GET", "/api/onboarding/gh/review")).body,
    );
    expect(review.ok).toBe(false);
  });

  it("checks and applies updates, and answers unknown routes with 404", async () => {
    const { base, deps } = await startDaemon();
    const check = validate(restEndpoints["updateCheck"].response, (await call(base, "GET", "/api/update")).body);
    expect(check).toEqual({ state: "updateAvailable", latestVersion: "bbbbbbb" });
    const fresh = validate(
      restEndpoints["updateCheckNow"].response,
      (await call(base, "POST", "/api/update/check")).body,
    );
    expect(fresh).toEqual(check);

    const applied = await call(base, "POST", "/api/update/apply");
    expect(validate(restEndpoints["updateApply"].response, applied.body)).toEqual({ ok: true });
    expect(deps.updateSpawns.at(-1)?.slice(1)).toEqual(["update"]);

    // A live worker gates the apply behind a 409.
    deps.registry.add(sessionRecord({ persona: "worker" }));
    expect((await call(base, "POST", "/api/update/apply")).status).toBe(409);

    expect((await call(base, "GET", "/api/nope")).status).toBe(404);
    expect((await call(base, "DELETE", "/api/status")).status).toBe(404);
  });

  it("validates request bodies and rejects malformed JSON", async () => {
    const { base } = await startDaemon();
    expect((await call(base, "POST", "/api/projects", { mode: "clone" })).status).toBe(400);
    expect((await call(base, "POST", "/api/sessions/x/send", { text: "" })).status).toBe(400);
    const badJson = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });
});

describe("WebSocket", () => {
  function connect(base: string): { ws: WebSocket; messages: Array<Record<string, unknown>> } {
    const ws = new WebSocket(`${base.replace("http://", "ws://")}/ws`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    return { ws, messages };
  }

  async function opened(ws: WebSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
  }

  it("sends sessions.changed and projects.changed on the same socket the terminal bridge uses", async () => {
    const { base, deps } = await startDaemon();
    const { ws, messages } = connect(base);
    await opened(ws);

    // A fresh client gets both current snapshots immediately.
    await vi.waitUntil(() => messages.length > 1);
    const initialSessions = SessionsChangedSchema.parse(messages[0]);
    expect(initialSessions.sessions).toHaveLength(0);
    const initialProjects = ProjectsChangedSchema.parse(messages[1]);
    expect(initialProjects.projects).toHaveLength(0);

    // A registry change made outside the API is picked up by the snapshot poll.
    const worker = sessionRecord();
    deps.registry.add(worker);
    await vi.waitUntil(() =>
      messages.some((m) => {
        const parsed = SessionsChangedSchema.safeParse(m);
        return parsed.success && parsed.data.sessions.some((v) => v.session.id === worker.id);
      }),
    );

    // The terminal bridge shares the socket: an unknown attach is closed by it.
    ws.send(JSON.stringify({ type: "terminal.attach", sessionId: "missing" }));
    await vi.waitUntil(() => ws.readyState === WebSocket.CLOSED);
    expect(
      messages.every((m) => m.type === "sessions.changed" || m.type === "projects.changed"),
    ).toBe(true);
  });

  it("broadcasts projects.changed when a project is added or removed", async () => {
    const { base, deps } = await startDaemon();
    const { ws, messages } = connect(base);
    await opened(ws);
    await vi.waitUntil(() => messages.length > 1);

    // A project change made outside the API is caught by the snapshot poll.
    await deps.projects.add({ mode: "clone", repoUrl: join(tmpdir(), "pideck-src", "acme", "widget") });
    await vi.waitUntil(() =>
      messages.some((m) => {
        const parsed = ProjectsChangedSchema.safeParse(m);
        return parsed.success && parsed.data.projects.length > 0;
      }),
    );
    const added = ProjectsChangedSchema.parse(
      messages.filter((m) => m.type === "projects.changed").at(-1),
    );
    expect(added.projects).toHaveLength(1);
    expect(added.projects[0]!.owner).toBe("acme");

    // An API mutation also broadcasts through the debounced hub.
    await call(base, "DELETE", `/api/projects/${added.projects[0]!.id}`);
    await vi.waitUntil(() => {
      const last = ProjectsChangedSchema.safeParse(
        messages.filter((m) => m.type === "projects.changed").at(-1),
      );
      return last.success && last.data.projects.length === 0;
    });
  });

  it("broadcasts after an API mutation", async () => {
    const { base, deps } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    const { ws, messages } = connect(base);
    await opened(ws);

    await call(base, "POST", `/api/sessions/${worker.id}/terminate`);
    await vi.waitUntil(() =>
      messages.some((m) => {
        if (m.type !== "sessions.changed") return false;
        const parsed = SessionsChangedSchema.safeParse(m);
        return parsed.success && parsed.data.sessions.some((v) => v.session.archivedAt !== undefined);
      }),
    );
  });
});

describe("static web app", () => {
  it("serves the built app with an index.html fallback", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "pideck-web-"));
    dirs.push(webDir);
    writeFileSync(`${webDir}/index.html`, "<html><body>pideck</body></html>");
    mkdirSync(`${webDir}/assets`);
    writeFileSync(`${webDir}/assets/app.js`, "console.log(1)");
    const { base } = await startDaemon({ webDistDir: webDir });

    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("pideck");

    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get("content-type")).toContain("text/javascript");

    // SPA fallback for an extension-less client route.
    const route = await fetch(`${base}/sessions/some-id`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain("pideck");

    // API keeps priority over static files; missing assets are a plain 404.
    expect((await call(base, "GET", "/api/nope")).status).toBe(404);
    expect((await fetch(`${base}/missing.png`)).status).toBe(404);
  });
});