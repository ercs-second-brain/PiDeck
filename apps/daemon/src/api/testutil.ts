/**
 * Test helpers for the API layer: a fake `gh` runner (no network) and a
 * pre-wired daemon context over tmp dirs with a FakeTmuxRunner.
 */

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GhClient, type GhRunner } from "../github/gh.js";
import { FakeTmuxRunner } from "../sessions/testing/fake-tmux.js";
import { Tmux } from "../sessions/tmux.js";
import type { GitRunner } from "../github/repos.js";

import { createDaemonContext, type DaemonContextOptions, type DaemonServices } from "./context.js";

export interface FakeGhRoutes {
  /** GraphQL responses keyed by a distinctive query substring. */
  graphql?: Record<string, unknown>;
  /** REST `gh api` responses keyed by path prefix (before `?`). */
  api?: Record<string, unknown>;
  /** `gh repo create` output (the new repo's URL). */
  repoCreate?: string;
  /** `gh pr diff <n>` output. */
  prDiff?: string;
  /** Failing paths (prefix → stderr). */
  errors?: Record<string, string>;
}

/** Builds a GhClient whose runner answers from in-memory route tables. */
export function fakeGh(routes: FakeGhRoutes): (repoUrl: string) => GhClient {
  const runner: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "graphql") {
      const vars = new Map<string, string>();
      for (let i = 2; i < args.length - 1; i++) {
        if (args[i] === "-f" || args[i] === "-F") {
          const kv = args[i + 1] ?? "";
          const eq = kv.indexOf("=");
          if (eq > 0) vars.set(kv.slice(0, eq), kv.slice(eq + 1));
        }
      }
      const query = vars.get("query") ?? "";
      for (const [needle, response] of Object.entries(routes.graphql ?? {})) {
        if (query.includes(needle)) {
          return { stdout: JSON.stringify({ data: response }), stderr: "" };
        }
      }
      throw new Error(`fake gh: unmatched graphql query: ${query.slice(0, 120)}`);
    }
    if (args[0] === "repo" && args[1] === "create") {
      if (routes.repoCreate === undefined) throw new Error("fake gh: no repoCreate configured");
      return { stdout: `${routes.repoCreate}\n`, stderr: "" };
    }
    if (args[0] === "pr" && args[1] === "diff") {
      if (routes.prDiff === undefined) throw new Error("fake gh: no prDiff configured");
      return { stdout: routes.prDiff, stderr: "" };
    }
    if (args[0] === "api" && typeof args[1] === "string") {
      const basePath = args[1].split("?")[0] ?? "";
      if (routes.errors?.[basePath] !== undefined) throw new Error(routes.errors[basePath]);
      const response = routes.api?.[basePath];
      if (response !== undefined) return { stdout: JSON.stringify(response), stderr: "" };
    }
    throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
  };
  return () => new GhClient(runner);
}

/** Fake git: records clones into a set; supports default-branch detection. */
export function fakeGit(cloned: Set<string>): GitRunner {
  return async (args) => {
    if (args[0] === "clone") {
      const dest = args[args.length - 1] ?? "";
      cloned.add(dest);
      mkdirSync(dest, { recursive: true });
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
    throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
  };
}

export interface TestDaemon {
  services: DaemonServices;
  stateDir: string;
  tmux: FakeTmuxRunner;
  cloned: Set<string>;
}

/** Builds a full daemon context over a tmp state dir with fake gh/git/tmux. */
export function testDaemon(
  ghRoutes: FakeGhRoutes = {},
  contextOptions: Partial<DaemonContextOptions> = {},
): TestDaemon {
  const stateDir = mkdtempSync(path.join(tmpdir(), "agentskiss-api-"));
  const tmux = new FakeTmuxRunner();
  const cloned = new Set<string>();
  const services = createDaemonContext({
    stateDir,
    tmux: new Tmux({ runner: tmux.asRunner() }),
    gh: fakeGh(ghRoutes),
    git: fakeGit(cloned),
    ...contextOptions,
  });
  return { services, stateDir, tmux, cloned };
}
