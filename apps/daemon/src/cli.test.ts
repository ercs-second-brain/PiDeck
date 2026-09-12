import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, type DaemonServer } from "./api/server.js";
import { makeDeps, sessionRecord } from "./api/testing.js";
import { FakeTmux } from "./sessions/testing/fakeTmux.js";
import { runCli, type CliIo } from "./cli.js";
import type { Trace } from "./reconciler/trace.js";

let daemons: DaemonServer[] = [];
let dirs: string[] = [];

afterEach(() => {
  for (const daemon of daemons) void daemon.close();
  daemons = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

async function startCliDaemon() {
  const stateDir = mkdtempSync(join(tmpdir(), "pideck-cli-"));
  dirs.push(stateDir);
  const tmux = new FakeTmux();
  const deps = makeDeps(stateDir, tmux);
  const daemon = await serve(deps, {
    host: "127.0.0.1",
    port: 0,
    webDistDir: null,
    pollMs: 20,
    debounceMs: 10,
    heartbeatMs: 0,
  });
  daemons.push(daemon);
  const project = await deps.projects.add({
    mode: "clone",
    repoUrl: join(tmpdir(), "pideck-src", "acme", "widget"),
  });
  return { daemon, deps, tmux, base: `http://127.0.0.1:${daemon.port}`, project };
}

function cliFor(base: string): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    url: base,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { io, stdout, stderr };
}

/** Waits for the hub's first state-derivation write for a session. */
async function untilDerived(trace: Trace, id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (trace.read(id).some((entry) => entry.kind === "state")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the hub never derived a state entry for ${id}`);
}

describe("cli", () => {
  it("prints status as JSON and as human lines", async () => {
    const { base } = await startCliDaemon();
    const asJson = cliFor(base);
    expect(await runCli(["status", "--json"], asJson.io)).toBe(0);
    expect(JSON.parse(asJson.stdout.join(""))).toMatchObject({ version: "0.0.0-test" });

    const human = cliFor(base);
    expect(await runCli(["status"], human.io)).toBe(0);
    expect(human.stdout.join("\n")).toContain("pi: ready");
  });

  it("lists and gets projects", async () => {
    const { base, project } = await startCliDaemon();
    const { io, stdout } = cliFor(base);
    expect(await runCli(["project", "ls"], io)).toBe(0);
    expect(stdout.join("\n")).toContain(project.id);

    const { io: io2, stdout: out2 } = cliFor(base);
    expect(await runCli(["project", "get", project.id, "--json"], io2)).toBe(0);
    expect(JSON.parse(out2.join(""))).toMatchObject({ id: project.id, owner: "acme" });
  });

  it("lists sessions and workers for a project", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ persona: "worker", projectId: project.id, issueNumber: 5 });
    const orchestrator = sessionRecord({ persona: "orchestrator", projectId: project.id });
    deps.registry.add(worker);
    deps.registry.add(orchestrator);

    const { io, stdout } = cliFor(base);
    expect(await runCli(["sessions", "--project", project.id], io)).toBe(0);
    expect(stdout.join("\n")).toContain(worker.id);
    expect(stdout.join("\n")).toContain(orchestrator.id);

    const { io: io2, stdout: out2 } = cliFor(base);
    expect(await runCli(["workers", "--project", project.id], io2)).toBe(0);
    expect(out2.join("\n")).toContain(worker.id);
    expect(out2.join("\n")).not.toContain(orchestrator.id);

    const { io: io3 } = cliFor(base);
    expect(await runCli(["workers"], io3)).toBe(2);
  });

  it("sends a message into the pane", async () => {
    const { base, deps, tmux } = await startCliDaemon();
    const worker = sessionRecord({ projectId: null });
    deps.registry.add(worker);
    tmux.createSession(worker.tmuxSession);

    const { io, stdout } = cliFor(base);
    expect(await runCli(["send", "--session", worker.id, "--message", "hello world"], io)).toBe(0);
    expect(tmux.sent).toEqual([{ session: worker.tmuxSession, text: "hello world" }]);
    expect(stdout.join("\n")).toContain("sent to");
  });

  it("prints a session's trace one entry per line, as JSON with --json", async () => {
    const { base, deps } = await startCliDaemon();
    const worker = sessionRecord({ projectId: null });
    deps.registry.add(worker);
    // The live hub derives the new session's view and traces the state
    // change; wait for that write so the file contents below are settled.
    await untilDerived(deps.trace, worker.id);
    deps.trace.append(worker.id, { at: "2026-01-01T00:00:00Z", kind: "spawn", detail: "spawned worker for issue #7" });
    deps.trace.append(worker.id, {
      at: "2026-01-01T00:01:00Z",
      kind: "delivery",
      text: "CI failed: build",
      watermark: { fixAttempts: 1 },
    });
    deps.trace.append(worker.id, {
      at: "2026-01-01T00:02:00Z",
      kind: "state",
      from: "working",
      to: "fixing",
      status: "fixing CI on PR #11",
    });

    const { io, stdout } = cliFor(base);
    expect(await runCli(["trace", worker.id], io)).toBe(0);
    const lines = stdout.join("\n").trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("state  - → working · working");
    expect(lines[1]).toContain("spawn  spawned worker for issue #7");
    expect(lines[2]).toContain("delivery  CI failed: build");
    expect(lines[3]).toContain("working → fixing · fixing CI on PR #11");

    const { io: jsonIo, stdout: jsonOut } = cliFor(base);
    expect(await runCli(["trace", worker.id, "--json"], jsonIo)).toBe(0);
    const parsed = JSON.parse(jsonOut.join(""));
    expect(parsed.entries).toHaveLength(4);
    expect(parsed.entries[0]).toMatchObject({ kind: "state", from: null, to: "working", status: "working" });
    expect(parsed.transcriptPath).toBeNull();
  });

  it("prints a session's transcript one entry per line, as JSON with --json", async () => {
    const { base, deps } = await startCliDaemon();
    const worker = sessionRecord({ projectId: null });
    deps.registry.add(worker);
    const dir = join(deps.stateDir, "pi-sessions", worker.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "2026-01-01T00-00-00-000Z_0000.jsonl"),
      readFileSync(join(import.meta.dirname, "sessions", "fixtures", "pi-transcript.jsonl"), "utf8"),
      "utf8",
    );

    const { io, stdout } = cliFor(base);
    expect(await runCli(["transcript", worker.id], io)).toBe(0);
    const lines = stdout.join("\n").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("user");
    expect(lines[0]).toContain("Run the shell command 'echo hi' and then stop.");
    expect(lines[1]).toContain("tool");
    expect(lines[1]).toContain('bash({"command":"echo hi"})');
    expect(lines[2]).toContain("assistant");
    expect(lines[2]).toContain("The command output `hi`");

    const { io: jsonIo, stdout: jsonOut } = cliFor(base);
    expect(await runCli(["transcript", worker.id, "--json"], jsonIo)).toBe(0);
    const parsed = JSON.parse(jsonOut.join(""));
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]).toMatchObject({ role: "user" });
  });

  it("usage-errors when transcript has no session id", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base);
    expect(await runCli(["transcript"], io)).toBe(2);
    expect(stderr.join("\n")).toContain("transcript needs a session id");
  });

  it("usage-errors when trace has no session id", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base);
    expect(await runCli(["trace"], io)).toBe(2);
    expect(stderr.join("\n")).toContain("trace needs a session id");
  });

  it("reports daemon errors on stderr with exit code 1", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base);
    expect(await runCli(["send", "--session", "nope", "--message", "hi"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("unknown session");
  });

  it("rejects unknown commands with usage on stderr", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base);
    expect(await runCli(["frobnicate"], io)).toBe(2);
    expect(stderr.join("\n")).toContain("usage:");
  });
});