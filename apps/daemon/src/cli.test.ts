import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serve, type DaemonServer } from "./api/server.js";
import { makeDeps, sessionRecord } from "./api/testing.js";
import { FakeTmux } from "./sessions/testing/fakeTmux.js";
import { runCli, type CliIo } from "./cli.js";
import { PI_TRANSCRIPT_JSONL } from "./sessions/testFixture.js";
import type { Trace } from "./reconciler/trace.js";
import type { VerbGh } from "./verbs.js";

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

function cliFor(
  base: string,
  opts: { env?: Record<string, string>; gh?: VerbGh; git?: (args: string[]) => Promise<string> } = {},
): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    url: base,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.gh !== undefined ? { gh: opts.gh } : {}),
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  };
  return { io, stdout, stderr };
}

type GhHandler = [
  match: (args: string[], input: string | undefined) => boolean,
  run: (args: string[], input: string | undefined) => string,
];

/** The REST path of a `gh api` invocation (after any --method). */
function apiPath(args: string[]): string | undefined {
  if (args[0] !== "api") return undefined;
  const methodIndex = args.indexOf("--method");
  return methodIndex === -1 ? args[1] : args[methodIndex + 2];
}

/** A gh runner for the verbs: first matching handler wins; misses throw. */
function fakeGh(handlers: GhHandler[]): {
  gh: VerbGh;
  calls: string[][];
  inputs: (string | undefined)[];
} {
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];
  const gh: VerbGh = async (args, input) => {
    calls.push(args);
    inputs.push(input);
    const hit = handlers.find(([match]) => match(args, input));
    if (hit === undefined) throw new Error(`unexpected gh call: ${args.join(" ")}`);
    return hit[1](args, input);
  };
  return { gh, calls, inputs };
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
    writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_0000.jsonl"), PI_TRANSCRIPT_JSONL, "utf8");

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

describe("session verbs", () => {
  it("errors when PD_SESSION_ID is unset", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base);
    expect(await runCli(["pr", "open"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("PD_SESSION_ID is unset");
  });

  it("errors on an unknown session", async () => {
    const { base } = await startCliDaemon();
    const { io, stderr } = cliFor(base, { env: { PD_SESSION_ID: "ghost" } });
    expect(await runCli(["blocked", "--body", "stuck"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("unknown session: ghost");
  });

  it("pr open pushes, appends Closes, and prints the PR URL", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5 });
    deps.registry.add(worker);
    const { gh, calls } = fakeGh([
      [(args) => args[1] === "list", () => "[]"],
      [(args) => apiPath(args)?.endsWith("/issues/5") === true, () => JSON.stringify({ title: "Add rate limiting" })],
      [(args) => args[1] === "create", () => "https://github.com/acme/widget/pull/12\n"],
    ]);
    const gitCalls: string[][] = [];
    const { io, stdout } = cliFor(base, {
      env: { PD_SESSION_ID: worker.id },
      gh,
      git: async (args) => {
        gitCalls.push(args);
        return "";
      },
    });
    expect(await runCli(["pr", "open", "--body", "Rate limits."], io)).toBe(0);
    expect(stdout).toEqual(["https://github.com/acme/widget/pull/12"]);
    expect(gitCalls).toEqual([["push", "-u", "origin", "pideck/issue-5"]]);
    const create = calls.find((args) => args[1] === "create")!;
    expect(create).toEqual([
      "pr", "create", "--repo", "acme/widget", "--base", "main", "--head", "pideck/issue-5",
      "--title", "Add rate limiting", "--body", "Rate limits.\n\nCloses #5",
    ]);
  });

  it("pr open is a no-op with the URL when the branch already has a PR", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5 });
    deps.registry.add(worker);
    const { gh, calls } = fakeGh([
      [(args) => args[1] === "list", () => JSON.stringify([{ number: 12, url: "https://github.com/acme/widget/pull/12" }])],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["pr", "open"], io)).toBe(0);
    expect(stdout).toEqual(["https://github.com/acme/widget/pull/12"]);
    expect(calls.some((args) => args[1] === "create")).toBe(false);
  });

  it("pr open keeps a body that already closes the issue", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5 });
    deps.registry.add(worker);
    const { gh, calls } = fakeGh([
      [(args) => args[1] === "list", () => "[]"],
      [(args) => apiPath(args)?.endsWith("/issues/5") === true, () => JSON.stringify({ title: "Add rate limiting" })],
      [(args) => args[1] === "create", () => "https://github.com/acme/widget/pull/12\n"],
    ]);
    const { io } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["pr", "open", "--title", "t", "--body", "Fixes #5 already"], io)).toBe(0);
    const create = calls.find((args) => args[1] === "create")!;
    expect(create.at(-1)).toBe("Fixes #5 already");
  });

  it("review files one review whose inline comments ride on the same call", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5, prNumber: 8 });
    deps.registry.add(worker);
    const { gh, calls, inputs } = fakeGh([
      [(args) => apiPath(args)?.endsWith("/reviews") === true, () => JSON.stringify({ id: 3 })],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(
      await runCli(
        ["review", "approve", "--body", "overall", "--file", "src/a.ts", "--line", "12", "--body", "fix this"],
        io,
      ),
    ).toBe(0);
    expect(stdout).toEqual(["https://github.com/acme/widget/pull/8"]);
    expect(JSON.parse(inputs[0]!)).toEqual({
      event: "APPROVE",
      body: "overall",
      comments: [{ path: "src/a.ts", line: 12, body: "fix this" }],
    });
    expect(calls[0]!.join(" ")).toContain("repos/acme/widget/pulls/8/reviews");
  });

  it("reply posts to the thread's replies endpoint and prints the discussion URL", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5, prNumber: 8 });
    deps.registry.add(worker);
    const { gh, calls } = fakeGh([
      [() => true, () => JSON.stringify({ id: 77 })],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["reply", "42", "--body", "addressed in 3f2c"], io)).toBe(0);
    expect(stdout).toEqual(["https://github.com/acme/widget/pull/8#discussion_r77"]);
    expect(calls[0]!.join(" ")).toContain("repos/acme/widget/pulls/8/comments/42/replies");
    expect(calls[0]).toContain("-f");
    expect(calls[0]).toContain("body=addressed in 3f2c");
  });

  it("blocked posts BLOCKED: on the issue and reminds to end the turn", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5 });
    deps.registry.add(worker);
    const { gh, calls } = fakeGh([
      [() => true, () => JSON.stringify({ id: 9 })],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["blocked", "--body", "no decision on X"], io)).toBe(0);
    expect(stdout).toEqual([
      "https://github.com/acme/widget/issues/5#issuecomment-9",
      "Your blocker is on GitHub — end the turn now; the orchestrator wakes you on reply.",
    ]);
    expect(calls[0]!.join(" ")).toContain("repos/acme/widget/issues/5/comments");
    expect(calls[0]).toContain("body=BLOCKED: no decision on X");
  });

  it("followup appends a bullet under ## Follow-ups, creating the section when missing", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5, prNumber: 8 });
    deps.registry.add(worker);
    let body = "Summary text.";
    const { gh } = fakeGh([
      [
        (args) => args.includes("--method") && args.includes("PATCH"),
        (args) => {
          body = args.find((arg) => arg.startsWith("body="))!.slice(5);
          return "";
        },
      ],
      [(args) => args[0] === "api" && !args.includes("--method"), () => JSON.stringify({ body })],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["followup", "--body", "extract the limiter"], io)).toBe(0);
    expect(stdout).toEqual(["https://github.com/acme/widget/pull/8"]);
    expect(body).toBe("Summary text.\n\n## Follow-ups\n\n- extract the limiter");

    // A second followup lands inside the existing section, before the next heading.
    body = "Summary.\n\n## Follow-ups\n\n- first\n\n## Notes\n\nsome text";
    expect(await runCli(["followup", "--body", "second"], io)).toBe(0);
    expect(body).toBe("Summary.\n\n## Follow-ups\n\n- first\n- second\n\n## Notes\n\nsome text");
  });

  it("threads lists review threads and resolve resolves one", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5, prNumber: 8 });
    deps.registry.add(worker);
    const threadsResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: "PRRT_1", isResolved: false, path: "src/a.ts", line: 12, comments: { nodes: [{ body: "fix this" }] } },
                { id: "PRRT_2", isResolved: true, path: "src/b.ts", line: null, comments: { nodes: [{ body: "done" }] } },
              ],
            },
          },
        },
      },
    };
    const { gh, calls } = fakeGh([
      [
        (args) => args[1] === "graphql" && args.some((arg) => arg.startsWith("query=mutation")),
        () => JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: true } } } }),
      ],
      [(args) => args[1] === "graphql", () => JSON.stringify(threadsResponse)],
    ]);
    const { io, stdout } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["threads"], io)).toBe(0);
    expect(stdout).toEqual([
      "PRRT_1  src/a.ts:12  open  fix this",
      "PRRT_2  src/b.ts:?  resolved  done",
    ]);
    expect(calls[0]!.join(" ")).toContain("reviewThreads");

    const { io: resolveIo, stdout: resolveOut } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["resolve", "PRRT_1"], resolveIo)).toBe(0);
    expect(resolveOut[0]).toContain("thread PRRT_1 resolved");
    expect(calls.at(-1)!.join(" ")).toContain("resolveReviewThread");
  });

  it("resolve fails when gh does not confirm the resolution", async () => {
    const { base, deps, project } = await startCliDaemon();
    const worker = sessionRecord({ projectId: project.id, issueNumber: 5, prNumber: 8 });
    deps.registry.add(worker);
    const { gh } = fakeGh([
      [(args) => args[1] === "graphql", () => JSON.stringify({ data: { resolveReviewThread: { thread: { isResolved: false } } } })],
    ]);
    const { io, stderr } = cliFor(base, { env: { PD_SESSION_ID: worker.id }, gh, git: async () => "" });
    expect(await runCli(["resolve", "PRRT_404"], io)).toBe(1);
    expect(stderr.join("\n")).toContain("did not confirm");
  });
});