/**
 * Shared harness for the PR-pipeline test files: fake GitHub (gh runner),
 * fake session control, and the full pipeline harness. Extracted when the
 * pipeline tests were split by theme (issue #106 refactor).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Session, Worker, WorkerStatus } from "@pideck/shared";

import { GhClient } from "../../github/gh.js";
import { countProjectOccupancy } from "../../sessions/occupancy.js";
import { restPull } from "../../testing/fixtures.js";
import type { PRPipelineEvent } from "./events.js";
import { PullRequestPipeline, type PRSessionControl } from "./pipeline.js";
import type { WorkerPipelineSettings } from "./settings.js";
import { PRTracker } from "./tracker.js";

export const PROJECT = "proj";
export const REPO = { owner: "o", repo: "r" };
const BASE_TIME = Date.parse("2026-09-06T12:00:00Z");

// ---------------------------------------------------------------------------
// Fake GitHub (gh runner)
// ---------------------------------------------------------------------------

export interface FakePR {
  pull: Record<string, unknown>;
  checkRuns: unknown;
  reviews: unknown[];
  comments: unknown[];
}

export function checkRuns(conclusion: "failure" | "success"): unknown {
  return { total_count: 1, check_runs: [{ name: "build", status: "completed", conclusion }] };
}

export function restComment(id: number, body: string, overrides: Partial<{ author: string; path: string; line: number | null }> = {}): Record<string, unknown> {
  return {
    id,
    user: { login: overrides.author ?? "alice" },
    body,
    path: overrides.path ?? "src/a.ts",
    line: overrides.line ?? 42,
    in_reply_to_id: null,
    html_url: `https://github.com/o/r/pull/12#discussion_r${id}`,
    created_at: "2026-09-06T12:00:00Z",
    updated_at: "2026-09-06T12:00:00Z",
  };
}

/** PR #12 open, red CI, no reviews, no comments — the common starting point. */
export function redFakePR(number = 12, overrides: Parameters<typeof restPull>[1] = {}): FakePR {
  return { pull: restPull(number, overrides), checkRuns: checkRuns("failure"), reviews: [], comments: [] };
}

/**
 * PR-pipeline fake GitHub: answers the pipeline's exact gh call sequence
 * (pull, check-runs by in-flight PR, reviews, comments, diff) from the
 * `prs`/`openList` state — unlike api/testutil's route-table gh fake, this
 * one models a fixed repo's PR set rather than arbitrary REST paths.
 */
function fakePipelineGh(prs: Map<number, FakePR>, openList: number[], assignments: Array<{ path: string; assignees: string[] }>, failAssignees: boolean): GhClient {
  // check-runs paths carry the commit SHA, not the PR number; the fake
  // tracks which PR's fetch is in flight (single pull first, then its
  // enrichment) to route those calls.
  let current = 0;
  return new GhClient(async (args) => {
    const p = args[1] ?? "";
    const json = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: "" });
    // Issue #408: the PR-assignment leg POSTs the issues-assignees endpoint.
    if (args[1] === "--method" && args[2] === "POST") {
      const path = args[3] ?? "";
      if (failAssignees) throw new Error("GitHub down");
      const assignees = args.flatMap((a, i) => (typeof a === "string" && args[i - 1] === "-f" && a.startsWith("assignees[]=") ? [a.slice("assignees[]=".length)] : []));
      assignments.push({ path, assignees });
      return json({ assignees: assignees.map((login) => ({ login })) });
    }
    if (p.includes("/pulls?state=open")) return json(openList.map((n) => prs.get(n)!.pull));
    const single = /\/pulls\/(\d+)$/.exec(p);
    if (single) {
      current = Number(single[1] ?? 0);
      return json(prs.get(current)!.pull);
    }
    const nested = /\/pulls\/(\d+)\//.exec(p);
    if (nested !== null) current = Number(nested[1] ?? 0);
    const pr = prs.get(current)!;
    if (p.includes("/comments")) return json(pr.comments);
    if (p.includes("/reviews")) return json(pr.reviews);
    if (p.includes("/check-runs")) return json(pr.checkRuns);
    throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
  });
}

// ---------------------------------------------------------------------------
// Fake session control
// ---------------------------------------------------------------------------

export interface SentPrompt {
  sessionId: string;
  keys: string;
}

export interface StatusChange {
  workerId: string;
  status: WorkerStatus;
  statusMessage?: string;
}

export function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: "worker-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    issueNumber: 7,
    prNumber: null,
    status: "running",
    statusMessage: null,
    startedAt: "2026-09-06T12:00:00Z",
    updatedAt: "2026-09-06T12:00:00Z",
    ...overrides,
  };
}

export function fakeSessions(
  workers: Worker[],
  kindSessions: Session[] = [],
): {
  control: PRSessionControl;
  prompts: SentPrompt[];
  statuses: StatusChange[];
  archived: string[];
  spawned: Array<{ projectId: string; request: { prNumber: number; parentWorkerId: string | null; prompt: string } }>;
} {
  const prompts: SentPrompt[] = [];
  const statuses: StatusChange[] = [];
  const archived: string[] = [];
  const spawned: Array<{ projectId: string; request: { prNumber: number; parentWorkerId: string | null; prompt: string } }> = [];
  const byId = new Map(workers.map((w) => [w.id, w]));
  let reviewerSeq = 0;
  const control: PRSessionControl = {
    listWorkers: (filter = {}) => workers.filter((w) => filter.projectId === undefined || w.projectId === filter.projectId),
    getWorker: (id) => byId.get(id),
    updateWorkerStatus: (workerId, status, statusMessage) => {
      const worker = byId.get(workerId);
      if (worker === undefined) throw new Error(`unknown worker: ${workerId}`);
      worker.status = status;
      worker.statusMessage = statusMessage ?? null;
      statuses.push({ workerId, status, statusMessage });
      return worker;
    },
    sendKeys: async (sessionId, keys) => {
      prompts.push({ sessionId, keys });
    },
    archiveWorker: async (workerId, message) => {
      const worker = byId.get(workerId);
      if (worker === undefined) return null;
      worker.status = "archived";
      worker.statusMessage = message ?? null;
      statuses.push({ workerId, status: "archived", statusMessage: message });
      archived.push(workerId);
      return worker;
    },
    spawnReviewAgent: async (projectId, request) => {
      spawned.push({ projectId, request });
      reviewerSeq += 1;
      const reviewer = makeWorker({
        id: `worker-reviewer-${reviewerSeq}`,
        sessionId: `sess-reviewer-${reviewerSeq}`,
        issueNumber: 0,
        prNumber: request.prNumber,
        kind: "reviewer",
        parentWorkerId: request.parentWorkerId,
        status: "running",
        statusMessage: "review agent running; prompt delivered",
      });
      workers.push(reviewer);
      byId.set(reviewer.id, reviewer);
      return reviewer;
    },
    // Issue #393: the same occupancy predicate the real wiring uses —
    // active workers + the injected kind sessions (every kind session a
    // fake passes in is treated as workerLike).
    countProjectOccupants: (projectId) =>
      countProjectOccupancy({
        workers: workers.filter((w) => w.projectId === projectId),
        sessions: kindSessions.filter((s) => s.projectId === projectId),
        isWorkerLikeKind: () => true,
      }),
  };
  return { control, prompts, statuses, archived, spawned };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export const REVIEW_USER = "review-bot";

export interface Harness {
  prs: Map<number, FakePR>;
  openList: number[];
  gh: GhClient;
  sessions: ReturnType<typeof fakeSessions>;
  tracker: PRTracker;
  emit: PRPipelineEvent[];
  now: () => Date;
  advance(ms: number): void;
  pipeline: PullRequestPipeline;
  poll(): Promise<PRPipelineEvent[]>;
  /** Issue #408: assignee POSTs the pipeline fired (path + parsed assignees). */
  assignments: Array<{ path: string; assignees: string[] }>;
}

export function makeHarness(
  options: {
    workers?: Worker[];
    /** Worker-like agent-kind sessions occupying concurrency (issue #393). */
    kindSessions?: Session[];
    maxFixAttempts?: number;
    fixPromptTimeoutMs?: number;
    trackerPath?: string;
    workerSettings?: () => WorkerPipelineSettings;
    workerCap?: () => number | undefined;
    /** Review account configured (issue #407)? Default true — reviewer tests. */
    reviewAccount?: () => boolean;
    /** Review-user login (issue #408): worker PRs are assigned to it on submission. Default: {@link REVIEW_USER} (issue #424 F2 — a configured account always carries its login). */
    reviewAccountUsername?: () => string;
    /** Issue #408 failure injection: the assignment POST rejects (the leg must be non-fatal). */
    failAssignees?: boolean;
    /** Pipeline error sink (default console.error — tests inject a quiet sink). */
    onError?: (err: unknown) => void;
  } = {},
): Harness {
  const prs = new Map<number, FakePR>();
  const openList: number[] = [];
  const assignments: Array<{ path: string; assignees: string[] }> = [];
  const gh = fakePipelineGh(prs, openList, assignments, options.failAssignees === true);
  const sessions = fakeSessions(options.workers ?? [makeWorker()], options.kindSessions);
  const trackerPath =
    options.trackerPath ?? path.join(mkdtempSync(path.join(tmpdir(), "pideck-prpipeline-")), "prs.json");
  const tracker = new PRTracker(trackerPath);
  const emitted: PRPipelineEvent[] = [];
  let clock = BASE_TIME;
  const now = () => new Date(clock);
  const pipeline = new PullRequestPipeline({
    gh,
    projectId: PROJECT,
    repo: REPO,
    sessions: sessions.control,
    tracker,
    emit: (event) => emitted.push(event),
    maxFixAttempts: options.maxFixAttempts,
    fixPromptTimeoutMs: options.fixPromptTimeoutMs,
    workerSettings: options.workerSettings,
    workerCap: options.workerCap,
    // Issue #407: harness default = review account configured (the review
    // cycle runs); tests pass `() => false` for single-account mode.
    reviewAccount: options.reviewAccount ?? (() => true),
    // Issue #408/#424 (F2): the review-user identity is ALWAYS configured —
    // both-or-neither settings validation makes a configured account carry
    // its login, so the assignment gate is live in the default mode. Tests
    // may override with their own login.
    reviewAccountUsername: options.reviewAccountUsername ?? (() => REVIEW_USER),
    ...(options.failAssignees === true || options.onError !== undefined
      ? { onError: options.onError ?? (() => undefined) }
      : {}),
    now,
  });
  return {
    prs,
    openList,
    gh,
    sessions,
    tracker,
    emit: emitted,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    pipeline,
    poll: () => pipeline.pollOnce(),
    assignments,
  };
}

export function prEvents(events: PRPipelineEvent[]): PRPipelineEvent[] {
  return events.filter((e) => e.type === "kanban.pr.card" || e.type === "kanban.pr.failed");
}
