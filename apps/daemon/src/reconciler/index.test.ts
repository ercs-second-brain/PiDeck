import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectSchema, ProjectSettingsSchema, ProbeSchema } from "@pideck/shared";
import { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import { ProjectStore } from "../store/projectStore.js";
import { SessionRegistry } from "../sessions/registry.js";
import { Tmux, TmuxError, type TmuxRunner } from "../sessions/tmux.js";
import { PromptOverrides } from "../prompts/overrides.js";
import { ciRollup, type GhComment, type GhPr, type GhReview } from "../github/schemas.js";
import { startReconciler, type GhClientLike, type ProjectFacts, type ReconcilerDeps } from "./index.js";

const project = ProjectSchema.parse({
  id: "my-api",
  name: "My API",
  repoUrl: "https://github.com/acme/my-api",
  owner: "acme",
  repo: "my-api",
  defaultBranch: "main",
  path: "/tmp/my-api",
});

const projectB = ProjectSchema.parse({
  id: "my-web",
  name: "My Web",
  repoUrl: "https://github.com/acme/my-web",
  owner: "acme",
  repo: "my-web",
  defaultBranch: "main",
  path: "/tmp/my-web",
});

interface FakeGhState {
  issues: ReturnType<typeof rawIssue>[];
  prs: GhPr[];
  comments: GhComment[];
  throwOnRead?: boolean;
}

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: "Add rate limiting",
    url: "https://github.com/acme/my-api/issues/1",
    assignees: ["acme-worker"],
    labels: [],
    ...overrides,
  };
}

function mappedPr(overrides: Record<string, unknown> = {}): GhPr {
  const raw = {
    number: 11,
    headRefName: "pideck/issue-1",
    headRefOid: "sha-1",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    ...overrides,
  };
  const rollup = ciRollup(raw.statusCheckRollup as Parameters<typeof ciRollup>[0]);
  return {
    number: raw.number,
    headBranch: raw.headRefName,
    headSha: raw.headRefOid,
    mergeable: raw.mergeable as GhPr["mergeable"],
    reviewDecision: (raw.reviewDecision as string | null) ?? null,
    ciStatus: rollup.ciStatus,
    failingChecks: rollup.failingChecks,
  };
}

function fakeGh(state: FakeGhState): GhClientLike {
  return {
    openIssues: async () => {
      if (state.throwOnRead) throw new Error("gh is down");
      return state.issues;
    },
    blockedBy: async () => [],
    issueComments: async () => state.comments,
    openPrs: async () => {
      if (state.throwOnRead) throw new Error("gh is down");
      return state.prs;
    },
    prReviews: async (): Promise<GhReview[]> => [],
    prReviewComments: async () => [],
    authStatus: async () => ProbeSchema.parse({ ok: true, detail: "logged in as acme-worker" }),
  };
}

function fakeTmux() {
  const calls: string[][] = [];
  const runner: TmuxRunner = async (args) => {
    calls.push(args);
    if (args[0] === "has-session") {
      // Panes live once created and never die unless the test says so.
      return { stdout: "", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  return { tmux: new Tmux({ runner, enterDelayMs: 0 }), calls };
}

/** Reassembles the lines delivered into panes. */
function sentLines(calls: string[][]): string[] {
  const lines: string[] = [];
  let buffer = "";
  for (const args of calls) {
    if (args[0] !== "send-keys") continue;
    if (args.includes("Enter")) {
      lines.push(buffer);
      buffer = "";
    } else if (args.includes("-H")) {
      buffer += Buffer.from(args.slice(args.indexOf("-H") + 1).join(""), "hex").toString("utf8");
    }
  }
  return lines;
}

describe("startReconciler", () => {
  let stateDir: string;
  let projects: ProjectStore;
  let settings: GlobalSettingsStore;
  let registry: SessionRegistry;
  let tmux: Tmux;
  let tmuxCalls: string[][];
  let ghStates: Map<string, FakeGhState>;
  let logs: string[];
  let deps: ReconcilerDeps;
  let handle: { stop(): void; tick(): Promise<void>; factsFor(projectId: string): ProjectFacts | null } | null = null;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "pideck-reconciler-"));
    projects = seededProjects(stateDir);
    settings = new GlobalSettingsStore(stateDir);
    registry = new SessionRegistry(stateDir);
    const tmuxAndCalls = fakeTmux();
    tmux = tmuxAndCalls.tmux;
    tmuxCalls = tmuxAndCalls.calls;
    ghStates = new Map();
    logs = [];
    deps = {
      gh: (repo) => {
        const key = repo.split("/")[1] ?? repo;
        return fakeGh(
          ghStates.get(key) ?? {
            issues: [],
            prs: [],
            comments: [],
            throwOnRead: ghStates.get(`throw:${key}`) !== undefined,
          },
        );
      },
      projects,
      settings,
      registry,
      tmux,
      prompts: new PromptOverrides(stateDir),
      stateDir,
      intervalMs: 3_600_000,
      git: async () => "",
      log: (line) => logs.push(line),
    };
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("spawns the global session, orchestrator, and worker, and is idempotent across ticks", async () => {
    ghStates.set("my-api", { issues: [rawIssue()], prs: [], comments: [] });
    handle = startReconciler(deps);

    await handle.tick();

    expect(registry.list({ persona: "global" })).toHaveLength(1);
    expect(registry.list({ persona: "orchestrator", projectId: "my-api" })).toHaveLength(1);
    expect(registry.list({ persona: "worker", projectId: "my-api" })).toHaveLength(1);
    const lines = sentLines(tmuxCalls);
    expect(lines.some((l) => l.startsWith("Briefing for My API"))).toBe(true);
    expect(lines.some((l) => l.includes('issue #1 "Add rate limiting"'))).toBe(true);
    const summary = logs.find((l) => l.includes("spawned,"))!;
    expect(summary).toContain("4 spawned");

    // The second tick finds everything in its desired state.
    await handle.tick();
    expect(registry.list({ persona: "worker" })).toHaveLength(1);
    const summaries = logs.filter((l) => l.includes("spawned,"));
    expect(summaries[summaries.length - 1]).toContain("0 spawned");
  });

  it("an error in one project never stops the others", async () => {
    ghStates.set("my-api", { issues: [rawIssue()], prs: [], comments: [] });
    ghStates.set("my-web", { issues: [], prs: [], comments: [], throwOnRead: true });
    handle = startReconciler(deps);

    await handle.tick();

    expect(registry.list({ projectId: "my-api", persona: "worker" })).toHaveLength(1);
    expect(registry.list({ projectId: "my-web" })).toHaveLength(0);
    expect(logs.some((l) => l.includes("project My Web: gh is down"))).toBe(true);
  });

  it("serves the last read pass to live views", async () => {
    ghStates.set("my-api", { issues: [rawIssue()], prs: [], comments: [] });
    handle = startReconciler(deps);

    expect(handle.factsFor("my-api")).toBeNull();
    await handle.tick();
    expect(handle.factsFor("my-api")?.issues.map((issue) => issue.number)).toEqual([1]);
    expect(handle.factsFor("my-web")?.issues).toEqual([]);
  });

  it("stops the interval loop", async () => {
    vi.useFakeTimers();
    try {
      ghStates.set("my-api", { issues: [rawIssue()], prs: [], comments: [] });
      deps = { ...deps, intervalMs: 10 };
      handle = startReconciler(deps);

      await vi.advanceTimersByTimeAsync(45);
      const ticksBefore = logs.filter((l) => l.startsWith("reconciler:")).length;
      expect(ticksBefore).toBeGreaterThanOrEqual(4);

      handle.stop();
      handle = null;
      await vi.advanceTimersByTimeAsync(100);
      expect(logs.filter((l) => l.startsWith("reconciler:")).length).toBe(ticksBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs once per tick that the review leg is off without a review account", async () => {
    ghStates.set("my-api", { issues: [], prs: [], comments: [] });
    handle = startReconciler(deps);
    await handle.tick();
    expect(logs.filter((l) => l.includes("the review leg is off"))).toHaveLength(1);
  });

  it("wiping the registry watermarks costs at most one duplicate delivery", async () => {
    ghStates.set("my-api", {
      issues: [rawIssue()],
      prs: [],
      comments: [{ id: 3, author: "acme-orch", body: "wake up", createdAt: "2025-06-01T10:00:00Z" }],
    });
    handle = startReconciler(deps);
    await handle.tick();
    const worker = registry.list({ persona: "worker" })[0]!;

    // CI goes red on a new head and the orchestrator answers on the issue.
    // Mutate the cached state: the gh client the reader holds closes over it.
    Object.assign(ghStates.get("my-api")!, {
      prs: [mappedPr({ statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }] })],
      comments: [
        { id: 3, author: "acme-orch", body: "wake up", createdAt: "2025-06-01T10:00:00Z" },
        { id: 4, author: "acme-orch", body: "answer", createdAt: "2025-06-01T10:05:00Z" },
      ],
    });
    await handle.tick();
    let lines = sentLines(tmuxCalls);
    expect(lines.filter((l) => l.includes("CI failed: build")).length).toBe(1);
    expect(lines.filter((l) => l.includes("New comment on issue #1")).length).toBe(1);
    expect(registry.get(worker.id)!.fixAttempts).toBe(1);

    // Wipe every watermark: the next tick may repeat each delivery once — no more.
    registry.update(worker.id, {
      lastPromptedHeadSha: null,
      lastDeliveredIssueCommentId: null,
      lastDeliveredPrCommentId: null,
      lastDeliveredReviewId: null,
      fixAttempts: 0,
      lastActivityAt: null,
    });
    tmuxCalls.length = 0;
    await handle.tick();
    lines = sentLines(tmuxCalls);
    expect(lines.filter((l) => l.includes("CI failed: build")).length).toBe(1);
    expect(lines.filter((l) => l.includes("New comment on issue #1")).length).toBe(1);
    expect(registry.get(worker.id)!.fixAttempts).toBe(1);

    // And after the watermarks are re-set, silence.
    tmuxCalls.length = 0;
    await handle.tick();
    lines = sentLines(tmuxCalls);
    expect(lines.filter((l) => l.includes("CI failed"))).toHaveLength(0);
    expect(lines.filter((l) => l.includes("New comment"))).toHaveLength(0);
  });
});

function seededProjects(stateDir: string): ProjectStore {
  const file = join(stateDir, "projects.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      projects: [project, projectB].map((p) => ({ project: p, settings: ProjectSettingsSchema.parse({}) })),
    }),
    "utf8",
  );
  return new ProjectStore(stateDir);
}

// Keep the unused-import linter honest about TmuxError use in future fakes.
void TmuxError;
