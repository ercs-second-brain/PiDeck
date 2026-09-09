/**
 * Shared fixtures for the contract-test files (extracted when the contract
 * suite was split by endpoint theme): the fake gh routes, the local-SHA
 * fixture, and a helper that boots a daemon HTTP server with a fetch-based
 * `api()` probe.
 */

import type { Server } from "node:http";
import path from "node:path";

import { createDaemonServer } from "./server.js";
import { testDaemon, type TestDaemon } from "./testutil.js";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
/** Local source HEAD used by the /api/update contract tests (issue #55). */
export const LOCAL_SHA = "a".repeat(40);

const ghRoutes = {
  graphql: {
    "pullRequests(first: $first": {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 9,
              title: "Fix the flaky test",
              url: "https://github.com/o/r/pull/9",
              updatedAt: UPDATED_AT,
              author: { login: "auto-agent" },
              headRefName: "ao/fix-flaky",
              baseRefName: "main",
              headRefOid: "abc123",
              reviewDecision: null,
              additions: 12,
              deletions: 4, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
            },
          ],
        },
      },
    },
    "issues(first: $first": {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 5,
              title: "Fix the flaky test",
              url: "https://github.com/o/r/issues/5",
              updatedAt: UPDATED_AT,
              assignees: { nodes: [] },
              blockedBy: { nodes: [] },
            },
            {
              number: 7,
              title: "Assigned work",
              url: "https://github.com/o/r/issues/7",
              updatedAt: UPDATED_AT,
              assignees: { nodes: [{ login: "auto-agent" }] },
              blockedBy: { nodes: [{ number: 5, state: "OPEN", repository: { nameWithOwner: "o/r" } }] },
            },
          ],
        },
      },
    },
  },
  api: {
    "/repos/o/r/pulls/9": {
      number: 9,
      title: "Fix the flaky test",
      state: "open",
      merged_at: null,
      user: { login: "auto-agent" },
      head: { ref: "ao/fix-flaky", sha: "abc123" },
      base: { ref: "main" },
      html_url: "https://github.com/o/r/pull/9",
      updated_at: UPDATED_AT,
    },
    "/repos/o/pidecktest": {
      html_url: "https://github.com/o/pidecktest",
      private: true,
      owner: { login: "o" },
      name: "pidecktest",
    },
  },
  repoCreate: "https://github.com/o/pidecktest",
  repoList: [
    { name: "pidecktest", owner: { login: "o" }, isPrivate: true },
    { name: "MixedCase", owner: { login: "o" }, isPrivate: false },
  ],
  prDiff: [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@",
    " const a = 1;",
    "+const b = 2;",
    "-const c = 3;",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1 @@",
    "+export {};",
    "",
  ].join("\n"),
};

type ApiProbe = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

function makeApi(base: string): ApiProbe {
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined };
  };
}

export interface ContractServer {
  daemon: TestDaemon;
  api: ApiProbe;
  /** Base URL of the running HTTP server (`http://127.0.0.1:<port>`). */
  base: string;
  close(): Promise<void>;
}

/** Boots one daemon + HTTP server (its own state dir) and an api() probe. */
export async function startContractServer(options: Parameters<typeof testDaemon>[1] = {}): Promise<ContractServer> {
  const daemon = testDaemon(ghRoutes, options);
  const created = createDaemonServer({ services: daemon.services, webDist: null });
  const server: Server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
  return {
    daemon,
    api: makeApi(base),
    base,
    close: async () => {
      daemon.services.hub.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Where testDaemon's fake update-shim bin lives (self-update tests). */
export function shimBinPath(daemon: TestDaemon): string {
  return path.join(daemon.stateDir, "bin", "pideck");
}
