/**
 * The fake gh's verb surface: exactly the calls the session CLI verbs make —
 * pr list/create, issue titles, review POST with inline comments, thread
 * replies, PR body PATCH, and the two GraphQL shapes (thread listing and
 * resolution). The script is executed directly against a seeded state file.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pideck-fake-gh-verbs-"));
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      seq: 1000,
      primaryLogin: "acme-worker",
      tokens: {},
      repos: {
        "acme/loop": {
          issues: [
            { number: 1, title: "Add rate limiting", url: "u", state: "open", assignees: [], labels: [], blockedBy: [] },
          ],
          comments: {},
          prs: [
            {
              number: 2,
              headRefName: "pideck/issue-1",
              headRefOid: "sha-2",
              mergeable: "MERGEABLE",
              checks: [],
              reviews: [],
              reviewComments: [
                { id: 7, threadId: "PRRT_7", user: "acme-review", body: "fix this", created_at: "t", path: "src/a.ts", line: 12 },
              ],
              requestedReviewers: [],
              body: "Summary.",
              state: "open",
            },
          ],
        },
      },
      invitations: [],
      readAccess: {},
    }),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the fake gh script with one optional stdin payload. */
function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [fakeGhScriptPath(), ...args],
      { env: { ...process.env, FAKE_GH_STATE: join(dir, "state.json") }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input ?? "");
  });
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line " +
  "comments(first:1){nodes{body}}}}}}}";

it("lists review threads with path, line, first comment, and resolved flag", async () => {
  const out = JSON.parse(await gh([
    "api", "graphql", "-f", `query=${THREADS_QUERY}`,
    "-f", "owner=acme", "-f", "name=loop", "-F", "number=2",
  ]));
  expect(out.data.repository.pullRequest.reviewThreads.nodes).toEqual([
    { id: "PRRT_7", isResolved: false, path: "src/a.ts", line: 12, comments: { nodes: [{ body: "fix this" }] } },
  ]);
});

it("resolves a thread by id and refuses unknown threads", async () => {
  const mutation =
    "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}";
  const out = JSON.parse(await gh(["api", "graphql", "-f", `query=${mutation}`, "-f", "id=PRRT_7"]));
  expect(out.data.resolveReviewThread.thread.isResolved).toBe(true);
  await expect(gh(["api", "graphql", "-f", `query=${mutation}`, "-f", "id=PRRT_999"])).rejects.toThrow("no review thread");
});

it("files one review whose inline comments become threads with ids", async () => {
  await gh(
    ["api", "--method", "POST", "repos/acme/loop/pulls/2/reviews", "--input", "-"],
    JSON.stringify({ event: "REQUEST_CHANGES", body: "see inline", comments: [{ path: "src/b.ts", line: 4, body: "here" }] }),
  );
  const state = JSON.parse(await gh(["__op", "repoState", '{"repo":"acme/loop"}']));
  expect(state.prs[0]!.reviews).toHaveLength(1);
  expect(state.prs[0]!.reviews[0]!.state).toBe("CHANGES_REQUESTED");
  expect(state.prs[0]!.reviewComments[1]).toMatchObject({ path: "src/b.ts", line: 4, body: "here" });
  const out = JSON.parse(await gh([
    "api", "graphql", "-f", `query=${THREADS_QUERY}`,
    "-f", "owner=acme", "-f", "name=loop", "-F", "number=2",
  ]));
  expect(out.data.repository.pullRequest.reviewThreads.nodes.map((n: { id: string }) => n.id))
    .toEqual(["PRRT_7", `PRRT_${state.prs[0]!.reviewComments[1]!.id}`]);
});

it("replies in a thread, patches the PR body, and serves the issue title", async () => {
  const reply = JSON.parse(await gh([
    "api", "--method", "POST", "repos/acme/loop/pulls/2/comments/7/replies", "-f", "body=addressed",
  ]));
  expect(reply.id).toBeGreaterThan(7);
  await gh(["api", "--method", "PATCH", "repos/acme/loop/pulls/2", "-f", "body=New body"]);
  expect(JSON.parse(await gh(["api", "repos/acme/loop/pulls/2"])).body).toBe("New body");
  expect(JSON.parse(await gh(["api", "repos/acme/loop/issues/1"])).title).toBe("Add rate limiting");
  const state = JSON.parse(await gh(["__op", "repoState", '{"repo":"acme/loop"}']));
  expect(state.prs[0]!.reviewComments[1]).toMatchObject({ in_reply_to: 7, path: "src/a.ts", body: "addressed" });
});

it("filters pr list by head and prints the URL", async () => {
  const out = JSON.parse(await gh([
    "pr", "list", "--repo", "acme/loop", "--head", "pideck/issue-1", "--state", "open", "--json", "number,url",
  ]));
  expect(out).toEqual([{ number: 2, url: "https://github.com/acme/loop/pull/2" }]);
  const none = JSON.parse(await gh([
    "pr", "list", "--repo", "acme/loop", "--head", "other", "--state", "open", "--json", "number,url",
  ]));
  expect(none).toEqual([]);
});

/** Locates `tools/fake-gh/gh` by walking up from this module. */
function fakeGhScriptPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "tools", "fake-gh", "gh");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Cannot locate tools/fake-gh/gh");
    dir = parent;
  }
}
