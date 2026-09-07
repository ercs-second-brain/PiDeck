import { describe, expect, it } from "vitest";

import type { GhRunner } from "../../github/gh.js";
import { GhClient } from "../../github/gh.js";
import { makeIssue } from "../../testing/fixtures.js";
import { GhBlockerResolver } from "./blockers.js";

const REPO = { owner: "o", repo: "r" };

interface BlockedByNode {
  number: number;
  state: "OPEN" | "CLOSED";
  repository: { nameWithOwner: string } | null;
}

/** One scripted GraphQL response: a blockedBy page, or a missing issue. */
type ScriptedPage = { nodes: BlockedByNode[]; hasNextPage?: boolean; endCursor?: string | null } | { missing: true };

/**
 * GhRunner serving scripted pages per issue number **in call order**, so a
 * paginated conversation is expressed as a simple sequence.
 */
function fakeGh(pages: Map<number, ScriptedPage[]>): { runner: GhRunner; queries: Array<Record<string, string | number>> } {
  const queries: Array<Record<string, string | number>> = [];
  const calls = new Map<number, number>();
  const runner: GhRunner = async (args) => {
    expect(args[0]).toBe("api");
    expect(args[1]).toBe("graphql");
    const variables: Record<string, string | number> = {};
    for (let i = 2; i < args.length; i += 2) {
      const flag = args[i];
      const value = args[i + 1];
      if (flag === undefined || value === undefined || !value.includes("=")) {
        throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
      }
      const eq = value.indexOf("=");
      variables[value.slice(0, eq)] = value.slice(eq + 1);
    }
    queries.push(variables);
    const number = Number(variables["number"]);
    const idx = calls.get(number) ?? 0;
    calls.set(number, idx + 1);
    const seq = pages.get(number);
    const page = seq?.[idx];
    if (page === undefined) throw new Error(`no scripted page ${idx} for issue ${number}`);
    if ("missing" in page) {
      return { stdout: JSON.stringify({ data: { repository: { issue: null } } }), stderr: "" };
    }
    return {
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              blockedBy: {
                totalCount: page.nodes.length,
                nodes: page.nodes,
                pageInfo: { hasNextPage: page.hasNextPage ?? false, endCursor: page.endCursor ?? null },
              },
            },
          },
        },
      }),
      stderr: "",
    };
  };
  return { runner, queries };
}

describe("GhBlockerResolver", () => {
  it("returns full blocker detail: closed kept, cross-repo kept with owner/repo, same-repo repository=null", async () => {
    const { runner } = fakeGh(
      new Map([
        [
          1,
          [
            {
              nodes: [
                { number: 2, state: "OPEN", repository: null },
                { number: 3, state: "CLOSED", repository: { nameWithOwner: "o/r" } },
                { number: 7, state: "OPEN", repository: { nameWithOwner: "other/repo" } },
              ],
            },
          ],
        ],
      ]),
    );
    const resolver = new GhBlockerResolver(new GhClient(runner));
    const blockers = await resolver.resolve(REPO, makeIssue(1));
    expect(blockers).toEqual([
      { number: 2, state: "open", repository: null },
      { number: 3, state: "closed", repository: null },
      { number: 7, state: "open", repository: "other/repo" },
    ]);
  });

  it("returns no blockers when the connection is empty", async () => {
    const { runner } = fakeGh(new Map([[1, [{ nodes: [] }]]]));
    const resolver = new GhBlockerResolver(new GhClient(runner));
    expect(await resolver.resolve(REPO, makeIssue(1))).toEqual([]);
  });

  it("follows pagination via endCursor", async () => {
    const { runner, queries } = fakeGh(
      new Map([
        [
          4,
          [
            {
              nodes: [{ number: 5, state: "OPEN", repository: null }],
              hasNextPage: true,
              endCursor: "cursor-1",
            },
            { nodes: [{ number: 6, state: "CLOSED", repository: null }] },
          ],
        ],
      ]),
    );
    const resolver = new GhBlockerResolver(new GhClient(runner));
    const blockers = await resolver.resolve(REPO, makeIssue(4));
    expect(blockers).toEqual([
      { number: 5, state: "open", repository: null },
      { number: 6, state: "closed", repository: null },
    ]);
    expect(queries).toHaveLength(2);
    expect(queries[1]?.["after"]).toBe("cursor-1");
  });

  it("throws when the issue does not exist", async () => {
    const { runner } = fakeGh(new Map([[404, [{ missing: true }]]]));
    const resolver = new GhBlockerResolver(new GhClient(runner));
    await expect(resolver.resolve(REPO, makeIssue(404))).rejects.toThrow(/not found/);
  });
});
