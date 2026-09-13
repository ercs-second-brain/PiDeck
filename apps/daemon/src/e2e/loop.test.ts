/**
 * The §2 loop end to end against the fake gh binary: the real reconciler,
 * real GhClient, a fake tmux, and a temp state dir walk
 * assign → worker → PR → CI red → fix → reviewer → changes requested →
 * fix → approval → orchestrator steer → merge → issue closed → dependent
 * unblocks. Every delivery text and watermark is asserted on the way.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PiProbeSchema, ProbeSchema, ProjectSchema, ProjectSettingsSchema } from "@pideck/shared";
import { serve, type DaemonServer } from "../api/server.js";
import { ReviewLoginFlow } from "../api/onboarding.js";
import type { DaemonDeps } from "../api/deps.js";
import { fakeCommandRunner } from "../api/testing.js";
import { createUpdater } from "../api/update.js";
import { runCli, type CliIo } from "../cli.js";
import { GhClient } from "../github/client.js";
import { PromptOverrides } from "../prompts/overrides.js";
import { startReconciler, type ReconcilerHandle } from "../reconciler/index.js";
import { Trace } from "../reconciler/trace.js";
import { SessionRegistry } from "../sessions/registry.js";
import { GlobalSettingsStore } from "../store/globalSettingsStore.js";
import { ProjectStore } from "../store/projectStore.js";
import { FakeGh } from "./fakeGh.js";
import { fakeTmux, sentLines } from "./harness.js";

const PRIMARY_LOGIN = "acme-worker";
const REVIEW_LOGIN = "acme-review";
const REVIEW_TOKEN = "tok-review-not-a-secret";

let stateDir: string;
let fakeGh: FakeGh;
let projects: ProjectStore;
let settings: GlobalSettingsStore;
let registry: SessionRegistry;
let tmuxCalls: string[][];
let logs: string[];
let handle: ReconcilerHandle | null = null;
let daemon: DaemonServer | null = null;
let cliOut: string[];

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pideck-loop-e2e-"));
  fakeGh = new FakeGh({
    repo: "acme/loop",
    primaryLogin: PRIMARY_LOGIN,
    reviewLogin: REVIEW_LOGIN,
    reviewToken: REVIEW_TOKEN,
  });
  projects = seededProjects(stateDir);
  settings = new GlobalSettingsStore(stateDir);
  settings.put({ reviewAccount: { username: REVIEW_LOGIN, token: REVIEW_TOKEN } });
  registry = new SessionRegistry(stateDir);
  logs = [];
  cliOut = [];
  const tmux = fakeTmux();
  tmuxCalls = tmux.calls;
  handle = startReconciler({
    gh: (repo) => new GhClient({ repo }),
    projects,
    settings,
    registry,
    tmux: tmux.tmux,
    prompts: new PromptOverrides(stateDir),
    stateDir,
    trace: new Trace(stateDir),
    intervalMs: 3_600_000,
    git: async () => "",
    log: (line) => {
      logs.push(line);
    },
  });
  daemon = null;
});

afterEach(async () => {
  handle?.stop();
  handle = null;
  await daemon?.close();
  daemon = null;
  fakeGh.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

/**
 * The daemon's HTTP surface, so the CLI verbs can resolve their session
 * context; built lazily, sharing the reconciler's stores.
 */
async function startApi(): Promise<string> {
  if (daemon === null) {
    const deps: DaemonDeps = {
      version: "0.0.0-test",
      buildSha: "main",
      stateDir,
      pollIntervalSeconds: 30,
      projects,
      settings,
      registry,
      tmux: fakeTmux().tmux,
      prompts: new PromptOverrides(stateDir),
      trace: new Trace(stateDir),
      updates: createUpdater({ srcDir: stateDir, registry, run: fakeCommandRunner, spawn: () => {} }),
      reviewLogin: new ReviewLoginFlow(
        stateDir,
        settings,
        () => {
          throw new Error("no gh process in the loop test");
        },
      ),
      ghPrimary: () => Promise.resolve(ProbeSchema.parse({ ok: true, detail: "logged in" })),
      ghReview: () => Promise.resolve(ProbeSchema.parse({ ok: true, detail: "logged in" })),
      pi: () =>
        Promise.resolve(
          PiProbeSchema.parse({ ok: true, detail: "pi", providers: [], models: [], defaultModel: null }),
        ),
    };
    daemon = await serve(deps, { host: "127.0.0.1", port: 0, webDistDir: null, heartbeatMs: 0 });
  }
  return `http://127.0.0.1:${daemon!.port}`;
}

/** Runs one CLI verb as a session (PD_SESSION_ID), with git stubbed out. */
async function runVerb(id: string, args: string[], env: Record<string, string> = {}): Promise<number> {
  const io: CliIo = {
    url: await startApi(),
    stdout: (line) => cliOut.push(line),
    stderr: () => {},
    env: { ...process.env, PD_SESSION_ID: id, ...env },
    git: async () => "",
  };
  return runCli(args, io);
}

it(
  "walks the whole loop: assign, PR, CI, review rounds, merge, unblock",
  async () => {
    await fakeGh.openIssue(1, "Add rate limiting");
    await fakeGh.openIssue(2, "Add pagination", [PRIMARY_LOGIN], [1]);

    // Tick 1: the orchestrator is briefed (in its system prompt, not as a
    // typed line); nothing is assigned to the worker account, and #2 is
    // blocked by #1 — no workers.
    await tick();
    expect(registry.list({ persona: "global" })).toHaveLength(1);
    expect(orchestrator()).toBeDefined();
    expect(registry.list({ persona: "worker" })).toHaveLength(0);
    const prompt = readFileSync(join(stateDir, "system-prompts", `${orchestrator()!.id}.md`), "utf8");
    expect(prompt).toContain("Briefing for Loop Repo");
    expect(sentLines(tmuxCalls)).toEqual([]);
    const access = await fakeGh.state();
    expect(access.readAccess["acme/loop"]).toContain(REVIEW_LOGIN);
    // Assign #1 → a worker is spawned with the spawn delivery.
    clearPanes();
    await fakeGh.assign(1, PRIMARY_LOGIN);
    await tick();
    const worker = registry.list({ persona: "worker", projectId: "loop" })[0]!;
    expect(worker.issueNumber).toBe(1);
    expect(sentLines(tmuxCalls)).toEqual([
      'Worker session for issue #1 "Add rate limiting" — work on branch pideck/issue-1, ' +
        'open the PR with pideck pr open (it adds "Closes #1") and give it a real body ' +
        '— a short "## What" summary of the change, never just Closes. https://github.com/acme/loop/issues/1',
    ]);
    expect(registry.get(worker.id)!.lastDeliveredIssueCommentId).toBeNull();

    // The worker opens its PR with `pideck pr open`: the verb creates the PR
    // on the fake gh as the pane's identity; the next reconciliation attaches
    // it to the session and watermarks the head, never green on first sight.
    clearPanes();
    cliOut = [];
    expect(await runVerb(worker.id, ["pr", "open", "--body", "Rate-limit the API."])).toBe(0);
    const prNumber = Number(cliOut[0]!.split("/").pop());
    expect(cliOut[0]).toMatch(/^https:\/\/github\.com\/acme\/loop\/pull\/\d+$/);
    await tick();
    expect(registry.get(worker.id)!.prNumber).toBe(prNumber);
    expect(registry.get(worker.id)!.lastPromptedHeadSha).toBe(`sha-${prNumber}`);
    expect(registry.list({ persona: "reviewer" })).toHaveLength(0);

    // CI green on the same head: the reviewer spawns, carrying the review
    // account's token into its pane.
    clearPanes();
    await fakeGh.setCI(prNumber, "ok");
    await tick();
    const reviewer = registry.list({ persona: "reviewer", projectId: "loop" })[0]!;
    expect(reviewer.prNumber).toBe(prNumber);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe(`sha-${prNumber}`);
    expect(sentLines(tmuxCalls)).toEqual([
      `Reviewer session for PR #${prNumber} in acme/loop — read the diff and the linked issue, ` +
        `then file exactly one review with pideck review: approve or request changes.`,
    ]);
    expect(tmuxCalls.some((args) => args[0] === "new-session" && paneEnvHasGhToken(args))).toBe(true);

    // CI red on a new head: the worker is told once, with the attempt count.
    clearPanes();
    await fakeGh.push(prNumber, "sha-a2", { status: "failed", failingChecks: ["ci"] });
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([
      "CI failed: ci (fix attempt 1 of 5). Read the failing runs on GitHub, fix, and push.",
    ]);
    let patched = registry.get(worker.id)!;
    expect(patched.fixAttempts).toBe(1);
    expect(patched.lastPromptedHeadSha).toBe("sha-a2");

    // CI green again: the reviewer is asked to re-review the new head.
    clearPanes();
    await fakeGh.setCI(prNumber, "ok");
    await tick();
    patched = registry.get(worker.id)!;
    expect(patched.fixAttempts).toBe(0);
    expect(patched.lastPromptedHeadSha).toBe("sha-a2");
    expect(sentLines(tmuxCalls)).toEqual([
      `New head on PR #${prNumber} — re-review and file your next single review with pideck review.`,
    ]);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe("sha-a2");

    // Changes requested: the worker is pointed at the review, watermark set.
    clearPanes();
    const reviewId = await fakeGh.addReview(prNumber, "CHANGES_REQUESTED", REVIEW_LOGIN, "fix the guard");
    await tick();
    patched = registry.get(worker.id)!;
    expect(sentLines(tmuxCalls)).toEqual([
      `New review activity on PR #${prNumber} — read the review on GitHub, reply in the threads ` +
        `with pideck reply, and push fixes.`,
    ]);
    expect(patched.lastDeliveredReviewId).toBe(reviewId);

    // A new push after the change request: CI runs on the new head; once
    // green and seen twice, the same reviewer re-reviews the new head.
    clearPanes();
    await fakeGh.push(prNumber, "sha-a3", { status: "pending" });
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([]);
    await fakeGh.setCI(prNumber, "ok");
    await tick();
    patched = registry.get(worker.id)!;
    expect(patched.lastPromptedHeadSha).toBe("sha-a3");
    expect(patched.fixAttempts).toBe(0);
    expect(sentLines(tmuxCalls)).toEqual([
      `New head on PR #${prNumber} — re-review and file your next single review with pideck review.`,
    ]);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe("sha-a3");

    // Approval, filed with `pideck review approve` as the reviewer: the
    // reviewer stays live for re-review duty, the orchestrator is steered,
    // and the worker's review watermark advances without a new prompt.
    clearPanes();
    cliOut = [];
    expect(await runVerb(reviewer.id, ["review", "approve", "--body", "nice"], { GH_TOKEN: REVIEW_TOKEN })).toBe(0);
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([
      `PR #${prNumber} for issue #1 is approved and green — alignment check.`,
    ]);
    const repoAfterApproval = await fakeGh.repo("acme/loop").state();
    const approvalId = repoAfterApproval.prs.find((pr) => pr.number === prNumber)!.reviews.find(
      (r) => r.state === "APPROVED",
    )!.id;
    expect(registry.get(worker.id)!.lastDeliveredReviewId).toBe(approvalId);
    expect(registry.get(reviewer.id)!.archivedAt).toBeUndefined();

    // Merge closes the issue via its body; the worker and the reviewer
    // archive together, and the blocked dependent #2 unblocks into a fresh
    // worker.
    clearPanes();
    await fakeGh.merge(prNumber);
    await tick();
    expect(registry.get(worker.id)!.archivedAt).toBeDefined();
    expect(registry.get(reviewer.id)!.archivedAt).toBeDefined();
    const state = await fakeGh.state();
    expect(state.repos["acme/loop"]!.prs.find((pr) => pr.number === prNumber)!.state).toBe("merged");
    expect(state.repos["acme/loop"]!.issues.find((issue) => issue.number === 1)!.state).toBe("closed");
    const dependent = registry.list({ persona: "worker", projectId: "loop", archived: false })[0]!;
    expect(dependent.issueNumber).toBe(2);
    expect(sentLines(tmuxCalls)).toEqual([
      'Worker session for issue #2 "Add pagination" — work on branch pideck/issue-2, ' +
        'open the PR with pideck pr open (it adds "Closes #2") and give it a real body ' +
        '— a short "## What" summary of the change, never just Closes. https://github.com/acme/loop/issues/2',
    ]);

    // The next reconciliation finds everything in its desired state.
    clearPanes();
    await tick();
    const summary = logs.filter((line) => line.includes("spawned,"))!.at(-1)!;
    expect(summary).toContain("0 spawned, 0 archived, 0 delivered");

    // Per-project isolation: a second registered project with its own
    // assigned issue gets its own worker, and the first project gains none.
    clearPanes();
    await fakeGh.addRepo("acme/api");
    await fakeGh.repo("acme/api").openIssue(1, "Add webhooks");
    await fakeGh.repo("acme/api").assign(1, PRIMARY_LOGIN);
    registerProject(stateDir, {
      id: "api",
      name: "API Repo",
      repoUrl: "https://github.com/acme/api",
      owner: "acme",
      repo: "api",
    });
    await tick();
    expect(registry.list({ persona: "worker", projectId: "api", archived: false }).map((s) => s.issueNumber))
      .toEqual([1]);
    expect(registry.list({ persona: "worker", projectId: "loop", archived: false }).map((s) => s.issueNumber))
      .toEqual([2]);
  },
  30_000,
);

function orchestrator() {
  return registry.list({ persona: "orchestrator", projectId: "loop", archived: false })[0];
}

async function tick(): Promise<void> {
  await handle!.tick();
}

function clearPanes(): void {
  tmuxCalls.length = 0;
}

/** Whether a recorded new-session invocation exports a review GH_TOKEN. */
function paneEnvHasGhToken(args: string[]): boolean {
  return args.some((arg) => arg.includes("export GH_TOKEN="));
}

function seededProjects(dir: string): ProjectStore {
  registerProject(dir, {
    id: "loop",
    name: "Loop Repo",
    repoUrl: "https://github.com/acme/loop",
    owner: "acme",
    repo: "loop",
  });
  return new ProjectStore(dir);
}

/** Appends one project (with default settings) to the store's projects.json. */
function registerProject(
  dir: string,
  spec: { id: string; name: string; repoUrl: string; owner: string; repo: string },
): void {
  const project = ProjectSchema.parse({
    ...spec,
    defaultBranch: "main",
    path: join(dir, "clone", spec.id),
  });
  mkdirSync(project.path, { recursive: true });
  const file = join(dir, "projects.json");
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { projects: unknown[] })
    : { projects: [] };
  writeFileSync(
    file,
    JSON.stringify({
      projects: [...current.projects, { project, settings: ProjectSettingsSchema.parse({}) }],
    }),
    "utf8",
  );
}
