/**
 * The §2 loop end to end against the fake gh binary: the real reconciler,
 * real GhClient, a fake tmux, and a temp state dir walk
 * assign → worker → PR → CI red → fix → reviewer → changes requested →
 * fix → approval → orchestrator steer → merge → issue closed → dependent
 * unblocks. Every delivery text and watermark is asserted on the way.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ProjectSchema, ProjectSettingsSchema } from "@pideck/shared";
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
  const tmux = fakeTmux();
  tmuxCalls = tmux.calls;
  handle = startReconciler({
    gh: (repo) => new GhClient({ repo }),
    projects,
    settings,
    registry,
    tmux: tmux.tmux,
    prompts: new PromptOverrides(stateDir),
    trace: new Trace(stateDir),
    stateDir,
    intervalMs: 3_600_000,
    git: async () => "",
    log: (line) => logs.push(line),
  });
});

afterEach(() => {
  handle?.stop();
  handle = null;
  fakeGh.dispose();
  rmSync(stateDir, { recursive: true, force: true });
});

it(
  "walks the whole loop: assign, PR, CI, review rounds, merge, unblock",
  async () => {
    await fakeGh.openIssue(1, "Add rate limiting");
    await fakeGh.openIssue(2, "Add pagination", [PRIMARY_LOGIN], [1]);

    // Tick 1: the orchestrator is briefed; nothing is assigned to the worker
    // account, and #2 is blocked by #1 — no workers.
    await tick();
    expect(registry.list({ persona: "global" })).toHaveLength(1);
    expect(orchestrator()).toBeDefined();
    expect(registry.list({ persona: "worker" })).toHaveLength(0);
    expect(sentLines(tmuxCalls).some((line) => line.startsWith("Briefing for Loop Repo"))).toBe(true);
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
        'open one PR with "Closes #1" in the body. https://github.com/acme/loop/issues/1',
    ]);
    expect(registry.get(worker.id)!.lastDeliveredIssueCommentId).toBeNull();

    // The worker opens its PR: attached to the session, head watermarked,
    // never treated as green on first sight.
    clearPanes();
    await fakeGh.openPr(11, 1, "sha-a1");
    await tick();
    expect(registry.get(worker.id)!.prNumber).toBe(11);
    expect(registry.get(worker.id)!.lastPromptedHeadSha).toBe("sha-a1");
    expect(registry.list({ persona: "reviewer" })).toHaveLength(0);

    // CI green on the same head: the reviewer spawns, carrying the review
    // account's token into its pane.
    clearPanes();
    await fakeGh.setCI(11, "ok");
    await tick();
    const reviewer = registry.list({ persona: "reviewer", projectId: "loop" })[0]!;
    expect(reviewer.prNumber).toBe(11);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe("sha-a1");
    expect(sentLines(tmuxCalls)).toEqual([
      "Reviewer session for PR #11 in acme/loop — read the diff and the linked issue, " +
        "then file exactly one review: approve or request changes.",
    ]);
    expect(tmuxCalls.some((args) => args[0] === "new-session" && paneEnvHasGhToken(args))).toBe(true);

    // CI red on a new head: the worker is told once, with the attempt count.
    clearPanes();
    await fakeGh.push(11, "sha-a2", { status: "failed", failingChecks: ["ci"] });
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([
      "CI failed: ci (fix attempt 1 of 5). Read the failing runs on GitHub, fix, and push.",
    ]);
    let patched = registry.get(worker.id)!;
    expect(patched.fixAttempts).toBe(1);
    expect(patched.lastPromptedHeadSha).toBe("sha-a2");

    // CI green again: the reviewer is asked to re-review the new head.
    clearPanes();
    await fakeGh.setCI(11, "ok");
    await tick();
    patched = registry.get(worker.id)!;
    expect(patched.fixAttempts).toBe(0);
    expect(patched.lastPromptedHeadSha).toBe("sha-a2");
    expect(sentLines(tmuxCalls)).toEqual([
      "New head on PR #11 — re-review and file your next single review.",
    ]);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe("sha-a2");

    // Changes requested: the worker is pointed at the review, watermark set.
    clearPanes();
    const reviewId = await fakeGh.addReview(11, "CHANGES_REQUESTED", REVIEW_LOGIN, "fix the guard");
    await tick();
    patched = registry.get(worker.id)!;
    expect(sentLines(tmuxCalls)).toEqual([
      "New review activity on PR #11 — read the review and comments on GitHub, " +
        "reply in the threads, and push fixes.",
    ]);
    expect(patched.lastDeliveredReviewId).toBe(reviewId);

    // A new push after the change request: CI runs on the new head; once
    // green and seen twice, the same reviewer re-reviews the new head.
    clearPanes();
    await fakeGh.push(11, "sha-a3", { status: "pending" });
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([]);
    await fakeGh.setCI(11, "ok");
    await tick();
    patched = registry.get(worker.id)!;
    expect(patched.lastPromptedHeadSha).toBe("sha-a3");
    expect(patched.fixAttempts).toBe(0);
    expect(sentLines(tmuxCalls)).toEqual([
      "New head on PR #11 — re-review and file your next single review.",
    ]);
    expect(registry.get(reviewer.id)!.lastPromptedHeadSha).toBe("sha-a3");

    // Approval: the reviewer is archived, the orchestrator is steered, the
    // worker's review watermark advances without a new prompt.
    clearPanes();
    const approvalId = await fakeGh.addReview(11, "APPROVED", REVIEW_LOGIN, "nice");
    await tick();
    expect(sentLines(tmuxCalls)).toEqual([
      "PR #11 for issue #1 is approved and green — alignment check.",
    ]);
    patched = registry.get(worker.id)!;
    expect(patched.lastDeliveredReviewId).toBe(approvalId);
    expect(registry.get(reviewer.id)!.archivedAt).toBeDefined();

    // Merge closes the issue via its body; the worker archives and the
    // blocked dependent #2 unblocks into a fresh worker.
    clearPanes();
    await fakeGh.merge(11);
    await tick();
    expect(registry.get(worker.id)!.archivedAt).toBeDefined();
    const state = await fakeGh.state();
    expect(state.prs.find((pr) => pr.number === 11)!.state).toBe("merged");
    expect(state.issues.find((issue) => issue.number === 1)!.state).toBe("closed");
    const dependent = registry.list({ persona: "worker", projectId: "loop", archived: false })[0]!;
    expect(dependent.issueNumber).toBe(2);
    expect(sentLines(tmuxCalls)).toEqual([
      'Worker session for issue #2 "Add pagination" — work on branch pideck/issue-2, ' +
        'open one PR with "Closes #2" in the body. https://github.com/acme/loop/issues/2',
    ]);

    // The next reconciliation finds everything in its desired state.
    clearPanes();
    await tick();
    const summary = logs.filter((line) => line.includes("spawned,"))!.at(-1)!;
    expect(summary).toContain("0 spawned, 0 archived, 0 delivered");
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
  const project = ProjectSchema.parse({
    id: "loop",
    name: "Loop Repo",
    repoUrl: "https://github.com/acme/loop",
    owner: "acme",
    repo: "loop",
    defaultBranch: "main",
    path: join(dir, "clone"),
  });
  mkdirSync(project.path, { recursive: true });
  const file = join(dir, "projects.json");
  writeFileSync(
    file,
    JSON.stringify({
      projects: [{ project, settings: ProjectSettingsSchema.parse({}) }],
    }),
    "utf8",
  );
  return new ProjectStore(dir);
}
