/**
 * Agent-kind CLI contract tests (issues #297/#300/#302 — the mechanism spec
 * is docs/agent-kinds.md).
 *
 * Covers the kind lifecycle end to end at the contract boundary:
 * 1. spawn — `pideck spawn --kind ...` sends the agent-kind body (kind +
 *    question for researchers, never --prompt/--issue) to the daemon's
 *    spawn endpoint and parses the returned Session (agent-kind sessions
 *    are not workers);
 * 2. run — the kind's persona is the prompt, so the CLI contract pins the
 *    persona files' read-only rules;
 * 3. report routing — per AGENT_KIND_REPORT_TARGET: the researcher
 *    persona delivers its report to `{{PARENT_SESSION_ID}}` (the calling
 *    session, via `pideck send`), the audit personas deliver to
 *    `{{ORCHESTRATOR_SESSION_ID}}` (the project orchestrator).
 *
 * The daemon-side spawn internals (kind registry, persona rendering,
 * parent stamping) are a separate lane — these tests pin the contract it
 * must satisfy, against stub daemons, without touching its code.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_KIND_REPORT_TARGET, AGENT_KINDS, type Session } from "@pideck/shared";

import { DaemonClient } from "./client.js";
import { run } from "./main.js";

/** Repo-root-relative path of a persona file (this file lives in apps/daemon/src/cli). */
function personaPath(kind: string): string {
  return fileURLToPath(new URL(`../../../../agent/prompts/${kind}.md`, import.meta.url));
}

/** A valid agent-kind session record as the daemon's spawn endpoint returns it. */
function kindSession(kind: string, overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-kind-1",
    projectId: "p1",
    role: "worker",
    tmuxSession: "pideck-p1-worker-3",
    agentKind: kind as Session["agentKind"],
    parentSessionId: "sess-caller-1",
    workerId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("pideck spawn --kind (CLI validation)", () => {
  /** Client that must never be reached by the validation cases below. */
  const unreachable = new DaemonClient("http://127.0.0.1:1");

  it("rejects an unknown kind, listing the valid kinds", async () => {
    await expect(
      run(["spawn", "--project", "p1", "--kind", "historian", "--name", "x"], unreachable),
    ).rejects.toThrow(/unknown agent kind "historian".*researcher, devex-audit, kiss-audit/s);
  });

  it("requires --question for researchers (the question is their input)", async () => {
    await expect(
      run(["spawn", "--project", "p1", "--kind", "researcher", "--name", "x"], unreachable),
    ).rejects.toThrow(/researcher needs --question/);
  });

  it("rejects --question for audit kinds (they take no input — the rule derives from the shared takesInput spec, #324)", async () => {
    await expect(
      run(
        ["spawn", "--project", "p1", "--kind", "devex-audit", "--name", "x", "--question", "why?"],
        unreachable,
      ),
    ).rejects.toThrow(/--question is not an input of kind "devex-audit"/);
  });

  it("rejects --issue and --prompt alongside --kind (agent kinds are not issue-owned; the persona is the prompt)", async () => {
    await expect(
      run(
        ["spawn", "--project", "p1", "--kind", "researcher", "--question", "q", "--issue", "5", "--name", "x"],
        unreachable,
      ),
    ).rejects.toThrow(/--issue cannot be combined with --kind/);
    await expect(
      run(
        ["spawn", "--project", "p1", "--kind", "kiss-audit", "--prompt", "do it", "--name", "x"],
        unreachable,
      ),
    ).rejects.toThrow(/--prompt cannot be combined with --kind/);
  });

  it("rejects --question on a plain worker spawn", async () => {
    await expect(
      run(["spawn", "--project", "p1", "--question", "q", "--name", "x", "--prompt", "task"], unreachable),
    ).rejects.toThrow(/--question is an agent-kind flag/);
  });
});

describe("pideck spawn --kind (daemon contract, stub daemon)", () => {
  let server: Server;
  let base: string;
  let lastSpawnBody: unknown;
  /** When true, the stub answers kind spawns with a worker record (contract-drift probe). */
  let driftReply = false;

  beforeEach(async () => {
    driftReply = false;
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/api/projects/p1/spawn") {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          lastSpawnBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const kind = (lastSpawnBody as { kind?: string }).kind;
          res.setHeader("Content-Type", "application/json");
          if (driftReply) {
            // Daemon contract drift: the endpoint answered a kind spawn
            // with a worker record — agent-kind sessions are not workers,
            // so the CLI must fail loudly instead of misreporting.
            res.end(JSON.stringify({ id: "w1", issueNumber: 0, status: "spawning" }));
            return;
          }
          res.statusCode = 201;
          res.end(JSON.stringify(kindSession(kind ?? "researcher")));
        });
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

  it("researcher: sends kind + question (no prompt/issue) and parses the session response", async () => {
    const client = new DaemonClient(base);
    const code = await run(
      ["spawn", "--project", "p1", "--kind", "researcher", "--question", "why is spawn slow?", "--name", "inv"],
      client,
    );
    expect(code).toBe(0);
    expect(lastSpawnBody).toEqual({ name: "inv", kind: "researcher", question: "why is spawn slow?" });
  });

  it("audit kinds: send kind + name only (persona is the prompt, no input flag)", async () => {
    const client = new DaemonClient(base);
    for (const kind of ["devex-audit", "kiss-audit"] as const) {
      await run(["spawn", "--project", "p1", "--kind", kind, "--name", "audit"], client);
      expect(lastSpawnBody).toEqual({ name: "audit", kind });
    }
    expect(Object.keys(AGENT_KIND_REPORT_TARGET)).toEqual([...AGENT_KINDS]);
  });

  it("fails loudly when the daemon answers a kind spawn with a worker record (contract drift)", async () => {
    driftReply = true;
    const client = new DaemonClient(base);
    await expect(
      run(["spawn", "--project", "p1", "--kind", "devex-audit", "--name", "audit"], client),
    ).rejects.toThrow();
  });
});

describe("pideck sessions (kind + parent rendering)", () => {
  let server: Server;
  let base: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify([
            {
              id: "orch-1",
              projectId: "p1",
              role: "orchestrator",
              tmuxSession: "pideck-p1-orchestrator-1",
              workerId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            kindSession("researcher"),
            kindSession("kiss-audit", { id: "sess-kind-2", agentKind: "kiss-audit" }),
          ]),
        );
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps agentKind + parentSessionId through the shared schema (JSON parity)", async () => {
    const sessions = await new DaemonClient(base).sessions();
    expect(sessions.map((s) => [s.id, s.agentKind, s.parentSessionId])).toEqual([
      ["orch-1", undefined, undefined],
      ["sess-kind-1", "researcher", "sess-caller-1"],
      ["sess-kind-2", "kiss-audit", "sess-caller-1"],
    ]);
  });

  it("human rendering shows kind and parent columns for agent-kind sessions", async () => {
    const code = await run(["sessions"], new DaemonClient(base));
    expect(code).toBe(0);
    const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines[0]).not.toMatch(/kind:/);
    expect(lines[1]).toMatch(/\tkind:researcher\tparent:sess-caller-1/);
    expect(lines[2]).toMatch(/\tkind:kiss-audit\tparent:sess-caller-1/);
  });
});

describe("report routing per kind (persona ↔ shared contract)", () => {
  /**
   * The delivery mechanism for every kind is `pideck send --session <id>`;
   * the persona decides the recipient via a placeholder. The shared
   * AGENT_KIND_REPORT_TARGET map is the contract — each persona must
   * deliver to the placeholder its kind's target names, and to no other.
   */
  const TARGET_PLACEHOLDER = {
    caller: "{{PARENT_SESSION_ID}}",
    "project-orchestrator": "{{ORCHESTRATOR_SESSION_ID}}",
  } as const;

  it("each persona's delivery line routes to its kind's report target", async () => {
    for (const kind of AGENT_KINDS) {
      const persona = await readFile(personaPath(kind), "utf8");
      const placeholder = TARGET_PLACEHOLDER[AGENT_KIND_REPORT_TARGET[kind]];
      expect(persona, `${kind} must deliver via pideck send to ${placeholder}`).toMatch(
        new RegExp(`pideck send --session ${placeholder.replace(/[{}]/g, "\\$&")}`),
      );
      const other = Object.values(TARGET_PLACEHOLDER).filter((p) => p !== placeholder);
      for (const wrong of other) {
        expect(persona, `${kind} must not route to ${wrong}`).not.toContain(wrong);
      }
    }
  });

  it("every kind's persona is read-only (findings and reports, never edits/PRs)", async () => {
    for (const kind of AGENT_KINDS) {
      const persona = await readFile(personaPath(kind), "utf8");
      expect(persona, `${kind} must declare read-only`).toMatch(/read-only/i);
      expect(persona, `${kind} must forbid PRs`).toMatch(/no PRs|never open PRs|never commits|no commits/i);
    }
  });
});
