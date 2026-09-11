/**
 * Shared IssueWatcher test fixtures: REST-shaped issue payloads and a
 * scripted GhClient driven by poll snapshots (extracted from watch.test.ts
 * so the issue-#504 regression tests can share them without importing a
 * test file's suite).
 */

import { GhClient } from "./gh.js";
import type { IssueRecord } from "./issues.js";

/** REST-shaped payload as the gh api issues endpoint would return it. */
export function restIssue(rec: IssueRecord): Record<string, unknown> {
  return {
    number: rec.issue.number,
    title: rec.issue.title,
    state: rec.issue.state,
    user: rec.author === null ? null : { login: rec.author },
    assignee: rec.assignees.length > 0 ? { login: rec.assignees[0] } : null,
    assignees: rec.assignees.map((login) => ({ login })),
    html_url: rec.issue.url,
    updated_at: rec.issue.updatedAt,
  };
}

/**
 * GhClient driven by a sequence of poll snapshots (REST issue lists, used by
 * IssueWatcher tests).
 */
export function scriptedGh(snapshots: Array<{ issues?: Record<string, unknown>[] }>): GhClient {
  let poll = 0;
  const at = (i: number) => snapshots[Math.min(Math.max(i, 0), snapshots.length - 1)] ?? {};
  return new GhClient(async (args) => {
    const path = args[1] ?? "";
    if (path.includes("/issues?state=open")) {
      const snap = at(poll);
      poll++;
      return { stdout: JSON.stringify(snap.issues ?? []), stderr: "" };
    }
    throw new Error(`unexpected args: ${JSON.stringify(args)}`);
  });
}