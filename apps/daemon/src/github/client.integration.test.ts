import { describe, expect, it } from "vitest";
import { GhClient } from "./client.js";

const enabled = process.env.PIDECK_GH_INTEGRATION === "1";
const repo = process.env.PIDECK_GH_INTEGRATION_REPO ?? "ercs-second-brain/PiDeck";

const d = enabled ? describe : describe.skip;

d("GhClient integration (opt-in: PIDECK_GH_INTEGRATION=1)", () => {
  const client = new GhClient({ repo });

  it(
    "probes the primary identity",
    async () => {
      const probe = await client.authStatus();
      expect(probe.ok).toBe(true);
      expect(probe.detail).toMatch(/logged in/);
    },
    30_000,
  );

  it(
    "lists open issues with assignees, labels and blocked-by state",
    async () => {
      const issues = await client.openIssues();
      expect(Array.isArray(issues)).toBe(true);
      for (const issue of issues) {
        expect(issue.number).toBeGreaterThan(0);
        expect(typeof issue.title).toBe("string");
        expect(Array.isArray(issue.assignees)).toBe(true);
        expect(Array.isArray(issue.labels)).toBe(true);
        for (const blocker of issue.blockedBy) {
          expect(["open", "closed"]).toContain(blocker.state);
        }
      }
    },
    120_000,
  );

  it(
    "lists open PRs with head, mergeable, review decision and CI rollup",
    async () => {
      const prs = await client.openPrs();
      for (const pr of prs) {
        expect(pr.headSha).toMatch(/^[0-9a-f]{40}$/);
        expect(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).toContain(pr.mergeable);
        expect(["ok", "pending", "failed"]).toContain(pr.ciStatus);
      }
    },
    120_000,
  );

  it(
    "reads an issue's comments and a PR's body and reviews",
    async () => {
      const comments = await client.issueComments(517);
      expect(comments.length).toBeGreaterThan(0);
      const since = await client.issueComments(517, comments[0]?.id);
      expect(since.every((c) => c.id > (comments[0]?.id ?? 0))).toBe(true);
      const body = await client.prBody(537);
      expect(typeof body).toBe("string");
      const reviews = await client.prReviews(537);
      expect(Array.isArray(reviews)).toBe(true);
      const prComments = await client.prReviewComments(537);
      expect(Array.isArray(prComments)).toBe(true);
    },
    120_000,
  );
});
