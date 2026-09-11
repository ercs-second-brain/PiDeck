/**
 * Idle-worker reuse tests (issue #471): the pi session-file context probe
 * (cwd slug, latest assistant usage, models-store context window,
 * conservative UNKNOWN fallbacks) and the default reuse policy's
 * eligibility matrix (lane match, `done` + pane alive, stall marks,
 * threshold).
 */

import { describe, expect, it } from "vitest";
import type { Worker } from "@pideck/shared";

import {
  DefaultReusePolicy,
  defaultAgentDir,
  piSessionDir,
  readWorkerContextUsage,
  type ContextUsage,
  type ContextUsageProbeDeps,
} from "./reuse.js";

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** A fake filesystem for the probe: readDir/readFile injected. */
function fs(files: Record<string, string>): Pick<ContextUsageProbeDeps, "readDir" | "readFile"> {
  return {
    readDir: async (dir) => {
      const names = Object.keys(files).filter((name) => name.startsWith(`${dir}/`));
      if (names.length === 0) throw new Error(`ENOENT: ${dir}`);
      return [...new Set(names.map((name) => name.slice(dir.length + 1).split("/")[0] as string))];
    },
    readFile: async (file) => {
      const content = files[file];
      if (content === undefined) throw new Error(`ENOENT: ${file}`);
      return content;
    },
  };
}

const MODELS_STORE = JSON.stringify({
  providers: {
    openrouter: {
      models: [
        { id: "m/big", contextWindow: 1000 },
        { id: "m/small", contextWindow: 100 },
      ],
    },
  },
});

/** One assistant message line with the given usage. */
function assistant(input: number, cacheRead: number, cacheWrite: number): string {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { input, cacheRead, cacheWrite, output: 1 } },
  });
}

function modelChange(provider: string, modelId: string): string {
  return JSON.stringify({ type: "model_change", provider, modelId });
}

const AGENT_DIR = "/agent";

/** Probe deps over the fake fs. */
function probe(files: Record<string, string>): ContextUsageProbeDeps {
  return { agentDir: AGENT_DIR, ...fs(files) };
}

describe("piSessionDir (issue #471)", () => {
  it("encodes cwd exactly like pi's getDefaultSessionDirPath", () => {
    expect(piSessionDir("/home/eric", "/a")).toBe("/a/sessions/--home-eric--");
    expect(piSessionDir("/home/eric/work space", "/a")).toBe("/a/sessions/--home-eric-work space--");
    expect(piSessionDir("C:\\repo", "/a")).toBe("/a/sessions/--C--repo--");
  });

  it("resolves the default agent dir from env or ~/.pi/agent", () => {
    expect(defaultAgentDir({ PI_CODING_AGENT_DIR: "/custom/pi" })).toBe("/custom/pi");
    expect(defaultAgentDir({})).toMatch(/\.pi\/agent$/);
  });
});

describe("readWorkerContextUsage (issue #471)", () => {
  const dir = piSessionDir("/work", AGENT_DIR);

  it("sums input+cacheRead+cacheWrite at the latest assistant message and divides by the model's context window", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/2026-09-10T01-00-00-000Z_s1.jsonl`]: [modelChange("openrouter", "m/big"), assistant(10, 40, 0), assistant(30, 60, 10)].join("\n"),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    // Latest assistant message: 30+60+10 = 100 of 1000 → 10%.
    expect(usage).toEqual({ kind: "known", used: 100, contextWindow: 1000, pct: 10 });
  });

  it("reads the newest session file (lexical timestamp order)", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/2026-09-09T01-00-00-000Z_old.jsonl`]: [modelChange("openrouter", "m/big"), assistant(900, 0, 0)].join("\n"),
      [`${dir}/2026-09-10T01-00-00-000Z_new.jsonl`]: [modelChange("openrouter", "m/big"), assistant(50, 0, 0)].join("\n"),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    expect(usage).toEqual({ kind: "known", used: 50, contextWindow: 1000, pct: 5 });
  });

  it("is UNKNOWN when the session dir is missing", async () => {
    const usage = await readWorkerContextUsage("/ghost", probe({ [`${AGENT_DIR}/models-store.json`]: MODELS_STORE }));
    expect(usage).toEqual({ kind: "unknown", reason: expect.stringContaining("unreadable") });
  });

  it("is UNKNOWN when the file has no assistant usage", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/s1.jsonl`]: modelChange("openrouter", "m/big"),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    expect(usage).toEqual({ kind: "unknown", reason: expect.stringContaining("no assistant usage") });
  });

  it("is UNKNOWN when the model is not in models-store.json", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/s1.jsonl`]: [modelChange("openrouter", "m/ghost"), assistant(1, 1, 1)].join("\n"),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    expect(usage).toEqual({ kind: "unknown", reason: expect.stringContaining("unknown context window") });
  });

  it("is UNKNOWN when there is no model_change at all", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/s1.jsonl`]: assistant(1, 1, 1),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    expect(usage).toEqual({ kind: "unknown", reason: expect.stringContaining("no model_change") });
  });

  it("is UNKNOWN when models-store.json is missing or corrupt", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/s1.jsonl`]: [modelChange("openrouter", "m/big"), assistant(1, 1, 1)].join("\n"),
    }));
    expect(usage).toEqual({ kind: "unknown", reason: expect.stringContaining("unknown context window") });
  });

  it("skips corrupt lines and unreadable files", async () => {
    const usage = await readWorkerContextUsage("/work", probe({
      [`${dir}/2026-09-10T01-00-00-000Z_a.jsonl`]: "not json\n{broken\n",
      [`${dir}/2026-09-09T01-00-00-000Z_b.jsonl`]: [modelChange("openrouter", "m/big"), assistant(100, 0, 0)].join("\n"),
      [`${AGENT_DIR}/models-store.json`]: MODELS_STORE,
    }));
    expect(usage).toEqual({ kind: "known", used: 100, contextWindow: 1000, pct: 10 });
  });
});

// ---------------------------------------------------------------------------
// Default reuse policy
// ---------------------------------------------------------------------------

const NOW = "2026-09-06T12:00:00Z";
const REQUEST = { projectId: "proj", lane: "backend", thresholdPct: 20 };

function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "w1",
    projectId: "proj",
    sessionId: "s1",
    issueNumber: 1,
    prNumbers: [],
    status: "done",
    statusMessage: "done",
    startedAt: NOW,
    updatedAt: NOW,
    lane: "backend",
    ...overrides,
  };
}

function makeSession(overrides: Partial<{ id: string; cwd: string | undefined; archivedAt: string }> = {}) {
  const id = overrides.id ?? "s1";
  return {
    id,
    projectId: "proj",
    role: "worker" as const,
    tmuxSession: `tmux-${id}`,
    workerId: "w1",
    createdAt: NOW,
    ...(overrides.cwd === undefined ? {} : { cwd: overrides.cwd }),
    ...(overrides.archivedAt === undefined ? {} : { archivedAt: overrides.archivedAt }),
  };
}

/** Scripted usage percentage of the 1000-token window (e.g. 20% → 200 tokens). */
function usageFiles(options: { usageKind: "known" | "unknown"; usagePct: number }): Record<string, string> {
  const dir = piSessionDir("/work", AGENT_DIR);
  const files: Record<string, string> = { [`${AGENT_DIR}/models-store.json`]: MODELS_STORE };
  if (options.usageKind === "unknown") {
    files[`${dir}/s1.jsonl`] = "no assistant usage here";
  } else {
    const used = Math.round(options.usagePct * 10);
    files[`${dir}/s1.jsonl`] = [modelChange("openrouter", "m/big"), assistant(used, 0, 0)].join("\n");
  }
  return files;
}

/** Harness routing eligibility through the REAL probe over a scripted fake fs. */
function policyWith(
  workers: Worker[],
  options: {
    alive?: () => boolean;
    usageKind?: "known" | "unknown";
    usagePct?: number;
    session?: ReturnType<typeof makeSession>;
  } = {},
): DefaultReusePolicy {
  const session = options.session ?? makeSession({ cwd: "/work" });
  return new DefaultReusePolicy({
    listWorkers: (projectId) => workers.filter((w) => w.projectId === projectId),
    getSession: (sessionId) => (session.id === sessionId ? session : undefined),
    isAlive: async () => options.alive?.() ?? true,
    probe: probe(usageFiles({ usageKind: options.usageKind ?? "known", usagePct: options.usagePct ?? 10 })),
  });
}

describe("DefaultReusePolicy (issue #471)", () => {
  it("finds a done same-lane worker with alive pane and in-budget context", async () => {
    const policy = policyWith([makeWorker()]);
    const found = await policy.findReusableWorker(REQUEST);
    expect(found?.id).toBe("w1");
  });

  it("rejects a lane mismatch", async () => {
    const policy = policyWith([{ ...makeWorker(), lane: "frontend" }]);
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects non-done workers (only terminal-done idles are capacity)", async () => {
    const policy = policyWith([{ ...makeWorker(), status: "running" }]);
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects a dead pane", async () => {
    const policy = policyWith([makeWorker()], { alive: () => false });
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects a stall-marked worker (#478)", async () => {
    const policy = policyWith([{ ...makeWorker(), statusMessage: "stalled: turn ended without a PR — re-prompted (attempt 1/2)" }]);
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects a worker over the threshold (usage pct > thresholdPct)", async () => {
    const policy = policyWith([makeWorker()], { usagePct: 20.1 });
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("accepts a worker exactly at the threshold", async () => {
    const policy = policyWith([makeWorker()], { usagePct: 20 });
    expect((await policy.findReusableWorker(REQUEST))?.id).toBe("w1");
  });

  it("rejects UNKNOWN usage conservatively", async () => {
    const policy = policyWith([makeWorker()], { usageKind: "unknown" });
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects a worker of another project", async () => {
    const policy = policyWith([{ ...makeWorker(), projectId: "other" }]);
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects an archived session", async () => {
    const policy = policyWith([makeWorker()], { session: makeSession({ cwd: "/work", archivedAt: NOW }) });
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("rejects a session without a recorded cwd (cannot probe)", async () => {
    const policy = policyWith([makeWorker()], { session: makeSession({ cwd: undefined }) });
    expect(await policy.findReusableWorker(REQUEST)).toBeNull();
  });

  it("matches the exact ContextUsage contract through the probe", async () => {
    const usage: ContextUsage = await readWorkerContextUsage("/work", probe(usageFiles({ usageKind: "known", usagePct: 10 })));
    expect(usage.kind).toBe("known");
  });
});
