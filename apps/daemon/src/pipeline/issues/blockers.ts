/**
 * Default {@link BlockerResolver}: resolves GitHub's native "blocked by"
 * relationship links for one issue via the github layer's
 * {@link fetchBlockedByDetail} (the one blocked-by GraphQL query + schema;
 * no github/ internals are duplicated here).
 *
 * Unlike the same-repo-open-only `resolveBlockedBy` helper in
 * `github/issues.ts`, this maps the **raw** blocker nodes (closed and
 * cross-repo included) onto the shared {@link IssueBlocker} contract; the
 * pipeline applies the open-state filter client-side, per the shared
 * contract docs ("GraphQL Issue.blockedBy includes closed blockers; whether
 * a blocker actually blocks work is an open-state question").
 */

import type { Issue, IssueBlocker } from "@agentskiss/shared";

import { fetchBlockedByDetail } from "../../github/issues.js";
import { formatRepoRef, type GhClient, type RepoRef } from "../../github/gh.js";
import type { BlockerResolver } from "./ports.js";

export class GhBlockerResolver implements BlockerResolver {
  constructor(private readonly gh: GhClient) {}

  async resolve(repo: RepoRef, issue: Issue): Promise<IssueBlocker[]> {
    const ownRepo = formatRepoRef(repo);
    const detail = await fetchBlockedByDetail(this.gh, repo, issue.number);
    return detail.blockers.map((node) => ({
      number: node.number,
      state: node.state === "OPEN" ? "open" : "closed",
      repository: node.repository !== null && node.repository !== ownRepo ? node.repository : null,
    }));
  }
}
