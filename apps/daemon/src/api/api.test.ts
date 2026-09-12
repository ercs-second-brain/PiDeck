import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import {
  restEndpoints,
  SessionsChangedSchema,
  type Project,
  type SessionView,
} from "@pideck/shared";
import { serve, type DaemonServer } from "./server.js";
import { makeDeps, FakeTmux, sessionRecord } from "./testing.js";

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
  });

  it("creates, lists, gets, patches and deletes projects", async () => {
    const { base } = await startDaemon();
    const project: Project = validate(restEndpoints["projectCreate"].response, (await addProject(base)).body);
    expect(project.owner).toBe("acme");
    expect(project.defaultBranch).toBe("main");

    const list = await call(base, "GET", "/api/projects");
    expect(validate(restEndpoints["projectList"].response, list.body)).toHaveLength(1);

    const got = await call(base, "GET", `/api/projects/${project.id}`);
    expect(validate(restEndpoints["projectGet"].response, got.body).id).toBe(project.id);

    const patched = await call(base, "PATCH", `/api/projects/${project.id}`, { name: "Renamed" });
    expect(validate(restEndpoints["projectUpdate"].response, patched.body).name).toBe("Renamed");

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
    expect(views.map((v) => v.state)).toEqual([null, null]);
    expect(views.find((v) => v.session.id === worker.id)?.status).toBe("working");
    expect(views.find((v) => v.session.id === orchestrator.id)?.status).toBe("");

    const perProject = await call(base, "GET", `/api/projects/${project.id}/sessions`);
    expect(validate(restEndpoints["projectSessionList"].response, perProject.body)).toHaveLength(2);
    expect((await call(base, "GET", "/api/projects/nope/sessions")).status).toBe(404);
  });

  it("sends a line into the pane and rejects unknown or archived sessions", async () => {
    const { base, deps, tmux } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    tmux.alive.add(worker.tmuxSession);

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

  it("terminates a session: archives, kills the pane, writes the log", async () => {
    const { base, deps, tmux } = await startDaemon();
    const worker = sessionRecord();
    deps.registry.add(worker);
    tmux.alive.add(worker.tmuxSession);

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

  it("answers not-yet-implemented endpoints with 501 and unknown routes with 404", async () => {
    const { base } = await startDaemon();
    expect((await call(base, "GET", "/api/update")).status).toBe(501);
    expect((await call(base, "POST", "/api/update/apply")).status).toBe(501);
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

  it("sends sessions.changed on the same socket the terminal bridge uses", async () => {
    const { base, deps } = await startDaemon();
    const { ws, messages } = connect(base);
    await opened(ws);

    // A fresh client gets the current snapshot immediately.
    await vi.waitUntil(() => messages.length > 0);
    const initial = SessionsChangedSchema.parse(messages[0]);
    expect(initial.sessions).toHaveLength(0);

    // A registry change made outside the API is picked up by the snapshot poll.
    const worker = sessionRecord();
    deps.registry.add(worker);
    await vi.waitUntil(() => messages.length > 1);
    const changed = SessionsChangedSchema.parse(messages.at(-1));
    expect(changed.sessions.map((v) => v.session.id)).toContain(worker.id);

    // The terminal bridge shares the socket: an unknown attach is closed by it.
    ws.send(JSON.stringify({ type: "terminal.attach", sessionId: "missing" }));
    await vi.waitUntil(() => ws.readyState === WebSocket.CLOSED);
    expect(messages.every((m) => m.type === "sessions.changed")).toBe(true);
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