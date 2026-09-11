/**
 * Regression tests for issue #504: assigning the gh account to two issues
 * back-to-back spawned only one worker. The watcher's first-sight branch
 * emitted `issue.created` only for an issue first seen WITH an assignee —
 * the orchestrator's create-then-assign flow (#491) puts creation and
 * assignment inside one poll window, and later polls never see an assignee
 * growth, so the second assignment's spawn trigger was silently lost. The
 * fix emits the paired `issue.assigned` transition on first sight.
 */

import { describe, expect, it } from "vitest";

import { makeIssueRecord } from "../testing/fixtures.js";
import { IssueWatcher } from "./watch.js";
import { restIssue, scriptedGh } from "./watch-fixtures.js";

const PROJECT = "proj";
const REPO = { owner: "o", repo: "r" };

describe("IssueWatcher first-sight assignment (#504)", () => {
  it("emits issue.assigned for an issue first seen already assigned (created+assigned inside one poll window)", async () => {
    // The orchestrator's create-then-assign flow (#491): the issue is
    // created AND assigned between two polls, so the watcher's first sight
    // carries the assignee. Later polls never see assignee growth — the
    // paired event here is the only spawn trigger.
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(506, { assignees: ["eric"] }))] },
      { issues: [restIssue(makeIssueRecord(506, { assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    const events = await watcher.pollOnce();
    expect(events.map((e) => e.type)).toEqual(["issue.created", "issue.assigned"]);
    expect(events[1]?.type === "issue.assigned" && events[1]?.issue.assignee).toBe("eric");
    // Stable afterwards: no re-emission on the next poll.
    expect(await watcher.pollOnce()).toEqual([]);
  });

  it("emits one assigned event per first-sight issue, back-to-back (two fresh assignments seconds apart)", async () => {
    // The exact #504 repro shape: two issues created and assigned
    // back-to-back land inside one poll window — each must carry its own
    // assignment event so two workers spawn.
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(505, { assignees: ["eric"] })), restIssue(makeIssueRecord(506, { assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    const events = await watcher.pollOnce();
    expect(events.map((e) => e.type)).toEqual(["issue.created", "issue.assigned", "issue.created", "issue.assigned"]);
    expect(events.filter((e) => e.type === "issue.assigned").map((e) => (e.type === "issue.assigned" ? e.issue.number : null))).toEqual([505, 506]);
  });

  it("still emits issue.assigned on assignee growth for issues first seen unassigned", async () => {
    // Guard the fix: the growth-based transition (#416) is untouched —
    // a first-sight unassigned issue spawns through the later growth event.
    const gh = scriptedGh([
      { issues: [restIssue(makeIssueRecord(506, { assignees: ["eric"] }))] },
      { issues: [restIssue(makeIssueRecord(506))] },
      { issues: [restIssue(makeIssueRecord(506, { assignees: ["eric"] }))] },
    ]);
    const watcher = new IssueWatcher({ gh, projectId: PROJECT, repo: REPO, emit: () => {} });
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.created", "issue.assigned"]);
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.unassigned"]);
    expect((await watcher.pollOnce()).map((e) => e.type)).toEqual(["issue.assigned"]);
  });
});