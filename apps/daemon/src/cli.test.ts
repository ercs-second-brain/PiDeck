import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, type DaemonServer } from "./api/server.js";
import { makeDeps, FakeTmux, sessionRecord } from "./api/testing.js";
import { runCli, type CliIo } from "./cli.js";

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
  const project = deps.projects.add({
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
    tmux.alive.add(worker.tmuxSession);

    const { io, stdout } = cliFor(base);
    expect(await runCli(["send", "--session", worker.id, "--message", "hello world"], io)).toBe(0);
    expect(tmux.sent).toEqual([{ session: worker.tmuxSession, text: "hello world" }]);
    expect(stdout.join("\n")).toContain("sent to");
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