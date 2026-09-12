/**
 * One GitHub read pass per project, turned into plain facts for the
 * reconciler. `blockedBy` is a per-issue call, so it (and the issue comment
 * list) is fetched only for assigned issues; unassigned issues carry no
 * comment data. Green is guarded against the empty-rollup race right after
 * a push: a PR counts as green only when its head SHA was already seen on
 * the previous read, so a PR that just appeared — or just changed head —
 * is never treated as green on first sight.
 */

import type { Probe } from "@pideck/shared";
import { isAssigned } from "./desired.js";
import type { GhClient } from "../github/client.js";
import { GhError } from "../github/error.js";
import type { CiStatus, GhComment, GhReview } from "../github/schemas.js";

/** The slice of GhClient the reconciler reads through. */
export interface GhRead {
  openIssues(): ReturnType<GhClient["openIssues"]>;
  blockedBy(issueNumber: number): ReturnType<GhClient["blockedBy"]>;
  issueComments(issueNumber: number, sinceId?: number): Promise<GhComment[]>;
  openPrs(): ReturnType<GhClient["openPrs"]>;
  prReviews(prNumber: number): Promise<GhReview[]>;
  prReviewComments(prNumber: number, sinceId?: number): Promise<GhComment[]>;
  authStatus(): Promise<Probe>;
}

export interface IssueFacts {
  number: number;
  title: string;
  url: string;
  assignees: string[];
  openBlockers: number;
  comments: GhComment[];
}

export interface PrFacts {
  number: number;
  headBranch: string;
  headSha: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string | null;
  ciStatus: CiStatus;
  failingChecks: string[];
  green: boolean;
  issueNumber: number | null;
  reviews: GhReview[];
  /** Inline review-thread comments (/pulls/{n}/comments). */
  reviewComments: GhComment[];
  /** Conversation comments on the PR as an issue (/issues/{n}/comments). */
  prComments: GhComment[];
}

export interface ProjectFacts {
  issues: IssueFacts[];
  prs: PrFacts[];
  primaryLogin: string | null;
  /** Set when the review account cannot read the repo; then no reviewer runs. */
  reviewAccess?: string;
}

const ISSUE_BRANCH = /^pideck\/issue-(\d+)$/;
const LOGIN_DETAIL = /logged in as ([A-Za-z0-9-]+)/;

export function parseIssueBranch(branch: string): number | null {
  const match = ISSUE_BRANCH.exec(branch);
  return match === null ? null : Number(match[1]);
}

export class ProjectReader {
  readonly #gh: GhRead;
  readonly #heads = new Map<number, string>();
  readonly #openBlockers = new Map<number, number>();
  readonly #log: ((line: string) => void) | null;
  #login: Promise<string | null> | null = null;

  constructor(gh: GhRead, log?: (line: string) => void) {
    this.#gh = gh;
    this.#log = log ?? null;
  }

  async read(): Promise<ProjectFacts> {
    const primaryLogin = await this.#resolveLogin();
    const [rawIssues, rawPrs] = await Promise.all([this.#gh.openIssues(), this.#gh.openPrs()]);

    const issues: IssueFacts[] = await Promise.all(
      rawIssues.map(async (issue) => {
        if (!isAssigned(issue, primaryLogin)) {
          return { ...issue, openBlockers: 0, comments: [] };
        }
        const [blockers, comments] = await Promise.all([
          this.#blockers(issue.number),
          this.#gh.issueComments(issue.number),
        ]);
        return {
          ...issue,
          openBlockers: blockers,
          comments,
        };
      }),
    );

    const prs: PrFacts[] = await Promise.all(
      rawPrs.map(async (pr) => {
        const [reviews, reviewComments, prComments] = await Promise.all([
          this.#gh.prReviews(pr.number),
          this.#gh.prReviewComments(pr.number),
          this.#gh.issueComments(pr.number),
        ]);
        const previousHead = this.#heads.get(pr.number);
        this.#heads.set(pr.number, pr.headSha);
        return {
          ...pr,
          green: pr.ciStatus === "ok" && previousHead === pr.headSha,
          issueNumber: parseIssueBranch(pr.headBranch),
          reviews,
          reviewComments,
          prComments,
        };
      }),
    );

    return { issues, prs, primaryLogin };
  }

  #resolveLogin(): Promise<string | null> {
    this.#login ??= this.#gh
      .authStatus()
      .then((probe) => probe.detail.match(LOGIN_DETAIL)?.[1] ?? null)
      .catch(() => null);
    return this.#login;
  }

  /**
   * The per-issue dependencies endpoint answers 404/403 for some issues; that
   * is not a repo-wide failure, so it degrades to the last known blocker count
   * (never to zero — an unknown blocker count must not unblock a worker).
   */
  async #blockers(issueNumber: number): Promise<number> {
    try {
      const blockers = await this.#gh.blockedBy(issueNumber);
      const open = blockers.filter((b) => b.state === "open").length;
      this.#openBlockers.set(issueNumber, open);
      return open;
    } catch (err) {
      if (!(err instanceof GhError) || !/HTTP 40[34]/.test(err.message)) throw err;
      this.#log?.(
        `reconciler: blockedBy #${issueNumber} unavailable (${err.message}) — keeping the last known blockers`,
      );
      return this.#openBlockers.get(issueNumber) ?? 0;
    }
  }
}
