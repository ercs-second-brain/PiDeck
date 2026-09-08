/**
 * Unit tests for the batched + TTL-cached PR listing service backing the
 * daemon API's pulls listing path (issue #40): O(1) gh calls per refresh,
 * stale-while-revalidate semantics, single-flight background refresh.
 */

import { describe, expect, it } from "vitest";
import type { PullRequest } from "@pideck/shared";

import { GhClient, type GhRunner } from "../github/gh.js";
import { PullListingService } from "./pull-listing.js";

const PROJECT = "o-r";
const REPO_URL = "https://github.com/o/r";

function pr(number: number, title = `PR ${number}`): PullRequest {
  return {
    projectId: PROJECT,
    number,
    title,
    state: "open",
    ciStatus: "unknown",
    reviewState: "none",
    headBranch: "feature",
    baseBranch: "main",
    author: "eric",
    url: `https://github.com/o/r/pull/${number}`,
    updatedAt: "2026-09-06T12:00:00Z",
  };
}

interface Harness {
  service: PullListingService;
  /** Advances the fake clock. */
  advance: (ms: number) => void;
  /** Number of gh invocations so far. */
  calls: () => number;
  /** Sets which PR numbers the next fetch serves. */
  serve: (numbers: number[]) => void;
  /** Makes the next fetch fail. */
  failNext: () => void;
}

function harness(ttlMs = 30_000): Harness {
  let now = 1_000_000;
  let calls = 0;
  let served: number[] = [1];
  let failing = false;
  const runner: GhRunner = async (args) => {
    calls++;
    if (failing) {
      failing = false;
      throw new Error("gh exploded");
    }
    if (args[0] !== "api" || args[1] !== "graphql") throw new Error(`unexpected args: ${JSON.stringify(args)}`);
    const nodes = served.map((n) => ({
      number: n,
      title: `PR ${n}`,
      url: `https://github.com/o/r/pull/${n}`,
      updatedAt: "2026-09-06T12:00:00Z",
      author: { login: "eric" },
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "abc123",
      reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    }));
    return { stdout: JSON.stringify({ data: { repository: { pullRequests: { nodes } } } }), stderr: "" };
  };
  const service = new PullListingService({
    gh: () => new GhClient(runner),
    ttlMs,
    now: () => now,
  });
  return {
    service,
    advance: (ms) => {
      now += ms;
    },
    calls: () => calls,
    serve: (numbers) => {
      served = numbers;
    },
    failNext: () => {
      failing = true;
    },
  };
}

describe("PullListingService", () => {
  it("fetches once and serves repeat calls from the TTL cache with zero gh calls", async () => {
    const h = harness();
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
    expect(h.calls()).toBe(1);
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
    expect(h.calls()).toBe(1);
  });

  it("stale-while-revalidate: serves the stale value immediately, refreshes in background", async () => {
    const h = harness();
    await h.service.list(PROJECT, REPO_URL);
    h.advance(30_001);
    h.serve([2]);
    // Stale hit: returns the cached value without blocking on the refresh.
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
    // Let the single-flight background refresh settle, then re-read.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls()).toBe(2);
    // Now fresh again: the refreshed value is served, no new call.
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(2)]);
    expect(h.calls()).toBe(2);
  });

  it("keeps the stale value when the background refresh fails", async () => {
    const h = harness();
    await h.service.list(PROJECT, REPO_URL);
    h.advance(30_001);
    h.failNext();
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls()).toBe(2);
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
  });

  it("propagates errors on the initial fetch (nothing to serve stale)", async () => {
    const h = harness();
    h.failNext();
    await expect(h.service.list(PROJECT, REPO_URL)).rejects.toThrow("gh exploded");
    // A later call retries instead of caching the failure.
    await expect(h.service.list(PROJECT, REPO_URL)).resolves.toEqual([pr(1)]);
  });

  it("coalesces concurrent stale reads into a single background refresh", async () => {
    const h = harness();
    await h.service.list(PROJECT, REPO_URL);
    h.advance(30_001);
    h.serve([2]);
    await Promise.all([h.service.list(PROJECT, REPO_URL), h.service.list(PROJECT, REPO_URL)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls()).toBe(2);
  });

  it("serves different projects independently", async () => {
    const h = harness();
    await h.service.list(PROJECT, REPO_URL);
    await h.service.list("other", "https://github.com/o/other");
    expect(h.calls()).toBe(2);
    await h.service.list(PROJECT, REPO_URL);
    await h.service.list("other", "https://github.com/o/other");
    expect(h.calls()).toBe(2);
  });
});
