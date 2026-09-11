/**
 * CLI tests: argument parsing, command dispatch/mapping, and the HTTP
 * client's contract validation + error handling against a real daemon.
 */

import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, parseArgs, positional, requireFlag } from "./args.js";
import { DaemonClient } from "./client.js";
import { run } from "./main.js";
import type { Project } from "@pideck/shared";

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
    expect(() => requireFlag({}, "project", "usage: pideck kanban --project <id>")).toThrow(CliError);
    expect(() => requireFlag({ project: "p" }, "project")).not.toThrow();
  });
});

class StubClient extends DaemonClient {
  readonly calls: Array<[string, unknown]> = [];
  override async status() {
    this.calls.push(["status", null]);
    return { ok: true, name: "pideck-daemon", projects: 2, sessions: 3, at: "2026-01-01T00:00:00.000Z" };
  }
  override async getProject(id: string): Promise<Project> {
    this.calls.push(["getProject", id]);
    return {
      id,
      name: id,
      repoUrl: `https://github.com/o/${id}`,
      defaultBranch: "main",
      settings: { workerConcurrency: 1 },
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
      prNumbers: [],
      status: "running" as const,
      statusMessage: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }
  override async send(sessionId: string, message: string) {
    this.calls.push(["send", { sessionId, message }]);
  }
  override async assign(projectId: string, issueNumber: number) {
    this.calls.push(["assign", { projectId, issueNumber }]);
    return { ok: true, issueNumber, assignee: "auto-agent", retriggered: false };
  }
}

describe("run() command dispatch", () => {
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

  it("rejects a >20 char --name (pinned by pideck spawn --help)", async () => {
    const client = new StubClient();
    await expect(run(["spawn", "--project", "p1", "--name", "x".repeat(21)], client)).rejects.toThrow(/≤ 20/);
    expect(client.calls).toHaveLength(0);
  });

  it("maps assign and rejects non-numeric --issue (issue #491)", async () => {
    const client = new StubClient();
    await run(["assign", "--project", "p1", "--issue", "5"], client);
    expect(client.calls.at(-1)).toEqual(["assign", { projectId: "p1", issueNumber: 5 }]);
    await expect(run(["assign", "--project", "p1"], client)).rejects.toThrow(/--issue/);
    await expect(run(["assign", "--project", "p1", "--issue", "x"], client)).rejects.toThrow(/positive number/);
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

});

/**
 * The `--lane` passthrough (issue #471): the idle-reuse key rides the spawn
 * request onto the worker record; the daemon re-tasks an eligible done
 * same-lane worker (context occupancy at/below the reuse threshold) instead
 * of spawning fresh. Malformed slugs are rejected client-side.
 */
describe("spawn --lane (issue #471)", () => {
  /** Minimal stub: only `spawn` is reached on this path. */
  class LaneStub extends DaemonClient {
    readonly calls: Array<[string, unknown]> = [];
    override async spawn(projectId: string, input: { issueNumber?: number; name: string; prompt?: string; lane?: string }) {
      this.calls.push(["spawn", { projectId, input }]);
      return {
        id: "worker-1",
        projectId,
        sessionId: "sess-1",
        issueNumber: input.issueNumber ?? 0,
        prNumbers: [],
        status: "running" as const,
        statusMessage: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }
  }

  it("passes --lane through to the spawn request", async () => {
    const client = new LaneStub();
    await run(["spawn", "--project", "p1", "--issue", "5", "--name", "w", "--lane", "backend"], client);
    expect(client.calls.at(-1)?.[0]).toBe("spawn");
    expect(client.calls.at(-1)?.[1]).toMatchObject({ input: { lane: "backend" } });
  });

  it("rejects a malformed --lane slug", async () => {
    const client = new LaneStub();
    await expect(run(["spawn", "--project", "p1", "--issue", "5", "--name", "w", "--lane", "Bad Lane"], client)).rejects.toThrow(/--lane/);
    await expect(run(["spawn", "--project", "p1", "--issue", "5", "--name", "w", "--lane", "-lead"], client)).rejects.toThrow(/--lane/);
    await expect(run(["spawn", "--project", "p1", "--issue", "5", "--name", "w", "--lane", "x".repeat(65)], client)).rejects.toThrow(/--lane/);
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
        res.end(JSON.stringify({ ok: true, name: "pideck-daemon", projects: 0, sessions: 0, at: "2026-01-01T00:00:00.000Z" }));
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
    expect((err as CliError).message).toContain("cannot reach the pideck daemon");
  });
});
