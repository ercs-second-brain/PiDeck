/**
 * Default {@link BlockerResolver}: resolves GitHub's native "blocked by"
 * relationship links for one issue via `GhClient.graphql` (the github/
 * interface — no github/ internals are imported).
 *
 * Unlike the same-repo-open-only `resolveBlockedBy` helper in
 * `github/issues.ts`, this returns the **raw** blocker nodes (closed and
 * cross-repo included) mapped onto the shared {@link IssueBlocker} contract;
 * the pipeline applies the open-state filter client-side, per the shared
 * contract docs ("GraphQL Issue.blockedBy includes closed blockers; whether
 * a blocker actually blocks work is an open-state question").
 */

import { z } from "zod";
import type { Issue, IssueBlocker } from "@agentskiss/shared";

import { formatRepoRef, type GhClient, type RepoRef } from "../../github/gh.js";
import type { BlockerResolver } from "./ports.js";

const blockedByDetailQuery = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      blockedBy(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number state repository { nameWithOwner } }
      }
    }
  }
}
` as const;

const blockedByDetailSchema = z.object({
  repository: z
    .object({
      issue: z
        .object({
          blockedBy: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(
              z.object({
                number: z.number().int().positive(),
                state: z.enum(["OPEN", "CLOSED"]),
                repository: z.object({ nameWithOwner: z.string() }).nullable(),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export class GhBlockerResolver implements BlockerResolver {
  constructor(private readonly gh: GhClient) {}

  async resolve(repo: RepoRef, issue: Issue): Promise<IssueBlocker[]> {
    const ownRepo = formatRepoRef(repo);
    const blockers: IssueBlocker[] = [];
    let after: string | undefined;
    for (;;) {
      const data = blockedByDetailSchema.parse(
        await this.gh.graphql(blockedByDetailQuery, {
          owner: repo.owner,
          name: repo.repo,
          number: issue.number,
          ...(after === undefined ? {} : { after }),
        }),
      );
      const connection = data.repository?.issue?.blockedBy;
      if (connection === undefined || connection === null) {
        throw new Error(`Issue #${issue.number} not found in ${ownRepo}`);
      }
      for (const node of connection.nodes) {
        const blockerRepo = node.repository?.nameWithOwner ?? null;
        blockers.push({
          number: node.number,
          state: node.state === "OPEN" ? "open" : "closed",
          repository: blockerRepo === ownRepo ? null : blockerRepo,
        });
      }
      if (!connection.pageInfo.hasNextPage || connection.pageInfo.endCursor === null) break;
      after = connection.pageInfo.endCursor;
    }
    return blockers;
  }
}
