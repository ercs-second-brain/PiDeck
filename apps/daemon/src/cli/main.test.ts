/**
 * CLI tests: argument parsing, command dispatch/mapping, and the HTTP
 * client's contract validation + error handling against a real daemon.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, parseArgs, positional, requireFlag } from "./args.js";
import { DaemonClient } from "./client.js";
import { run } from "./main.js";
import { currentTmuxSession } from "./tmux-context.js";
import type { Project } from "@agentskiss/shared";

describe("parseArgs", () => {
  it("separates command positionals from flags", () => {
    const parsed = parseArgs(["project", "get", "o-r", "--json"]);
    expect(parsed.positionals).toEqual(["project", "get", "o-r"]);
    expect(parsed.flags).toEqual({ json: true });
  });

  it("supports --flag value, --flag=value, and boolean flags", () => {
    const parsed = parseArgs(["spawn", "--project", "p1", "--name=label x", "--verbose"]);
    expect(parsed.flags["project"]).toBe("p1");
    expect(parsed.flags["name"]).toBe("label x");
    expect(parsed.flags["verbose"]).toBe(true);
  });

  it("collects repeated flags as arrays", () => {
    const parsed = parseArgs(["x", "--tag", "a", "--tag", "b"]);
    expect(parsed.flags["tag"]).toEqual(["a", "b"]);
  });

  it("treats trailing positionals after flags correctly (diff --project x 42)", () => {
    const parsed = parseArgs(["diff", "--project", "o-r", "42"]);
    expect(parsed.positionals).toEqual(["diff", "42"]);
    expect(parsed.flags["project"]).toBe("o-r");
    expect(positional(parsed, 1)).toBe("42");
  });

  it("handles -- separator for literal args", () => {
    const parsed = parseArgs(["send", "--message", "hi", "--", "--not-a-flag"]);
    expect(parsed.flags["message"]).toBe("hi");
    expect(parsed.positionals).toEqual(["send", "--not-a-flag"]);
  });

  it("requires flags via requireFlag with usage text", () => {
    expect(() => requireFlag({}, "project", "usage: agentskiss kanban --project <id>")).toThrow(CliError);
    expect(() => requireFlag({ project: "p" }, "project")).not.toThrow();
  });
});

describe("run() command dispatch", () => {
  class StubClient extends DaemonClient {
    readonly calls: Array<[string, unknown]> = [];
    override async status() {
      this.calls.push(["status", null]);
      return { ok: true, name: "agentskiss-daemon", projects: 2, sessions: 3, at: "2026-01-01T00:00:00.000Z" };
    }
    override async getProject(id: string): Promise<Project> {
      this.calls.push(["getProject", id]);
      return {
        id,
        name: id,
        repoUrl: `https://github.com/o/${id}`,
        defaultBranch: "main",
        settings: { autoAgentUsername: null, workerConcurrency: 1 },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
    override async kanban(projectId: string) {
      this.calls.push(["kanban", projectId]);
      return {
        projectId,
        updatedAt: "2026-01-01T00:00:00.000Z",
        columns: [
          { column: "backlog" as const, cards: [] },
          { column: "in_progress" as const, cards: [] },
          { column: "in_review" as const, cards: [] },
          { column: "done" as const, cards: [] },
        ],
      };
    }
    override async spawn(projectId: string, input: { issueNumber?: number; name: string; prompt?: string }) {
      this.calls.push(["spawn", { projectId, input }]);
      return {
        id: "worker-1",
        projectId,
        sessionId: "sess-1",
        issueNumber: input.issueNumber ?? 0,
        prNumber: null,
        status: "running" as const,
        statusMessage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
    override async send(sessionId: string, message: string) {
      this.calls.push(["send", { sessionId, message }]);
    }
    override async reportPr(tmuxSession: string, prNumber: number) {
      this.calls.push(["reportPr", { tmuxSession, prNumber }]);
      return {
        id: "worker-1",
        projectId: "p1",
        sessionId: "sess-1",
        issueNumber: 5,
        prNumber,
        status: "running" as const,
        statusMessage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
  }

  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("maps status to client.status and prints JSON with --json", async () => {
    const client = new StubClient();
    const code = await run(["status", "--json"], client);
    expect(code).toBe(0);
    expect(client.calls).toEqual([["status", null]]);
    expect(logSpy.mock.calls[0]?.[0]).toContain('"ok": true');
  });

  it("maps project get/ls, kanban, spawn, and send", async () => {
    const client = new StubClient();
    await expect(run(["project", "get"], client)).rejects.toThrow(/unknown project|usage/i);
    await run(["kanban", "--project", "p1"], client);
    expect(client.calls.at(-1)).toEqual(["kanban", "p1"]);
    await run(["spawn", "--project", "p1", "--issue", "5", "--name", "worker-a"], client);
    expect(client.calls.at(-1)?.[0]).toBe("spawn");
    await run(["send", "--session", "sess-1", "--message", "hello"], client);
    expect(client.calls.at(-1)).toEqual(["send", { sessionId: "sess-1", message: "hello" }]);
  });

  it("rejects a >20 char --name (pinned by the spawn-worker skill)", async () => {
    const client = new StubClient();
    await expect(run(["spawn", "--project", "p1", "--name", "x".repeat(21)], client)).rejects.toThrow(/≤ 20/);
    expect(client.calls).toHaveLength(0);
  });

  it("rejects spawn without --issue or --prompt", async () => {
    const client = new StubClient();
    await expect(run(["spawn", "--project", "p1", "--name", "w"], client)).rejects.toThrow(/--issue|--prompt/);
  });

  it("prints usage for no args and errors for unknown commands", async () => {
    await expect(run([], new StubClient())).resolves.toBe(0);
    await expect(run(["bogus"], new StubClient())).rejects.toThrow(/unknown command/);
  });

  it("diff requires a numeric PR argument", async () => {
    const client = new StubClient();
    await expect(run(["diff", "--project", "p1", "abc"], client)).rejects.toThrow(/pr-number/);
  });

  it("report-pr sends the self-identified tmux session and PR number (issue #49)", async () => {
    const client = new StubClient();
    const code = await run(
      ["report-pr", "42"],
      client,
      { tmuxSession: async () => "agentskiss-p1-worker-1" },
    );
    expect(code).toBe(0);
    expect(client.calls.at(-1)).toEqual(["reportPr", { tmuxSession: "agentskiss-p1-worker-1", prNumber: 42 }]);
  });

  it("report-pr requires a numeric PR argument and a tmux context", async () => {
    const client = new StubClient();
    await expect(run(["report-pr", "abc"], client, { tmuxSession: async () => "s" })).rejects.toThrow(/pr-number/);
    await expect(
      run(["report-pr"], client, { tmuxSession: async () => "s" }),
    ).rejects.toThrow(/pr-number/);
    // No tmux context → the CLI refuses before talking to the daemon.
    await expect(
      run(["report-pr", "42"], client, {
        tmuxSession: async () => {
          throw new CliError("report-pr must run inside an agentskiss worker tmux session");
        },
      }),
    ).rejects.toThrow(/tmux session/);
    expect(client.calls).toHaveLength(0);
  });
});

describe("currentTmuxSession (report-pr context resolution)", () => {
  it("throws when not inside tmux (no TMUX env)", async () => {
    await expect(currentTmuxSession({})).rejects.toThrow(/inside an agentskiss worker tmux session/);
  });

  it("resolves the session name via tmux display-message in the pane's context", async () => {
    const calls: string[][] = [];
    const name = await currentTmuxSession({ TMUX: "/tmp/tmux-0/default,1,0" }, async (args) => {
      calls.push(args);
      return "agentskiss-p1-worker-1\n";
    });
    expect(name).toBe("agentskiss-p1-worker-1");
    expect(calls).toEqual([["display-message", "-p", "#S"]]);
  });

  it("maps tmux failures to a CliError", async () => {
    await expect(
      currentTmuxSession({ TMUX: "/tmp/tmux-0/default,1,0" }, async () => {
        throw new Error("no server running");
      }),
    ).rejects.toThrow(CliError);
  });
});

describe("DaemonClient against a live daemon", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/api/status") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, name: "agentskiss-daemon", projects: 0, sessions: 0, at: "2026-01-01T00:00:00.000Z" }));
        return;
      }
      if (url.pathname.endsWith("/spawn")) {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: "worker concurrency cap reached" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("fetches status and maps daemon errors to CliError with the server message", async () => {
    const client = new DaemonClient(base);
    const status = await client.status();
    expect(status.ok).toBe(true);

    const err = await client.spawn("p", { issueNumber: 1, name: "w" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain("worker concurrency cap reached");
  });

  it("surfaces unreachable daemons as a CliError with a hint", async () => {
    const client = new DaemonClient("http://127.0.0.1:1"); // nothing listens there
    const err = await client.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain("cannot reach the agentskiss daemon");
  });
});
