import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { PRTracker } from "./tracker.js";
import { prCardId } from "@pideck/shared";

let filePath: string;

beforeEach(() => {
  filePath = path.join(mkdtempSync(path.join(tmpdir(), "pideck-prtracker-")), "prs.json");
});

function register(tracker: PRTracker, prNumber = 12, workerId = "worker-1") {
  return tracker.register({
    projectId: "proj",
    prNumber,
    headBranch: `agent/issue-7`,
    workerId,
    sessionId: "sess-1",
    title: `PR ${prNumber}`,
  });
}

describe("PRTracker", () => {
  it("registers PRs with loop state initialized", () => {
    const tracker = new PRTracker(filePath);
    const tracked = register(tracker);
    expect(tracked.state).toBe("watching");
    expect(tracked.fixAttempts).toBe(0);
    expect(tracked.lastPromptedAt).toBeNull();
    expect(tracked.lastSeenCommentId).toBeNull();
    expect(tracked.lastReviewSeenAt).toBeNull();
    expect(tracked.reviewWorkerId).toBeNull();
    expect(prCardId("proj", 12)).toBe("pr:proj:12");
    expect(tracker.get("proj", 12)).toBe(tracked);
  });

  it("persists state across instances (daemon restart)", () => {
    const tracker = new PRTracker(filePath);
    const tracked = register(tracker);
    tracked.state = "fixing";
    tracked.fixAttempts = 2;
    tracked.lastPromptedHeadSha = "sha-2";
    tracked.lastSeenCommentId = 101;
    tracked.lastReviewSeenAt = "2026-09-06T12:05:00Z";
    tracker.save();

    const reloaded = new PRTracker(filePath);
    const restored = reloaded.get("proj", 12);
    expect(restored).toMatchObject({
      projectId: "proj",
      prNumber: 12,
      headBranch: "agent/issue-7",
      workerId: "worker-1",
      sessionId: "sess-1",
      state: "fixing",
      fixAttempts: 2,
      lastPromptedHeadSha: "sha-2",
      lastSeenCommentId: 101,
      lastReviewSeenAt: "2026-09-06T12:05:00Z",
    });
  });

  it("starts empty on a corrupt file", () => {
    const tracker = new PRTracker(filePath);
    register(tracker);
    tracker.save();
    expect(new PRTracker(filePath).list()).toHaveLength(1);
    writeFileSync(filePath, "{not json", "utf8");
    expect(new PRTracker(filePath).list()).toHaveLength(0);
  });

  it("listActive excludes terminal states", () => {
    const tracker = new PRTracker(filePath);
    const active = register(tracker, 1);
    const done = register(tracker, 2, "worker-2");
    const failed = register(tracker, 3, "worker-3");
    done.state = "done";
    failed.state = "failed";
    expect(tracker.listActive()).toEqual([active]);
    expect(tracker.list()).toHaveLength(3);
  });
});
