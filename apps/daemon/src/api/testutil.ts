/**
 * Test helpers for the API layer: a fake `gh` runner (no network) and a
 * pre-wired daemon context over tmp dirs with a FakeTmuxRunner.
 */

import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GhClient, type GhRunner, type GhRunResult } from "../github/gh.js";
import type { PiRunner } from "../agent/pi-auth.js";
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
  /** `gh repo list --json name,owner,isPrivate` output (issue #217). */
  repoList?: Array<{ name: string; owner: { login: string }; isPrivate: boolean }>;
  /** `gh pr diff <n>` output. */
  prDiff?: string;
  /** Failing paths (prefix → stderr). */
  errors?: Record<string, string>;
}

/** Matches the `gh api graphql` invocation against the in-memory routes. */
function graphqlRoute(graphql: Record<string, unknown>, args: string[]): GhRunResult {
  const vars = new Map<string, string>();
  for (let i = 2; i < args.length - 1; i++) {
    if (args[i] === "-f" || args[i] === "-F") {
      const kv = args[i + 1] ?? "";
      const eq = kv.indexOf("=");
      if (eq > 0) vars.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
  }
  const query = vars.get("query") ?? "";
  for (const [needle, response] of Object.entries(graphql)) {
    if (query.includes(needle)) return { stdout: JSON.stringify({ data: response }), stderr: "" };
  }
  throw new Error(`fake gh: unmatched graphql query: ${query.slice(0, 120)}`);
}

/** Matches the simple single-invocation gh commands (create/list/diff). */
function simpleRoutes(routes: FakeGhRoutes, args: string[]): GhRunResult | undefined {
  if (args[0] !== "repo" && args[0] !== "pr") return undefined;
  if (args[0] === "repo" && args[1] === "create") {
    if (routes.repoCreate === undefined) throw new Error("fake gh: no repoCreate configured");
    return { stdout: `${routes.repoCreate}\n`, stderr: "" };
  }
  if (args[0] === "repo" && args[1] === "list") {
    if (routes.repoList === undefined) throw new Error("fake gh: no repoList configured");
    return { stdout: JSON.stringify(routes.repoList), stderr: "" };
  }
  if (args[0] === "pr" && args[1] === "diff") {
    if (routes.prDiff === undefined) throw new Error("fake gh: no prDiff configured");
    return { stdout: routes.prDiff, stderr: "" };
  }
  return undefined;
}

/** Matches the `gh api <path>` invocations (REST route table). */
function apiRoute(routes: FakeGhRoutes, args: string[]): GhRunResult | undefined {
  if (args[0] !== "api" || typeof args[1] !== "string" || args[1] === "graphql") return undefined;
  const basePath = args[1].split("?")[0] ?? "";
  if (routes.errors?.[basePath] !== undefined) throw new Error(routes.errors[basePath]);
  const response = routes.api?.[basePath];
  if (response === undefined) return undefined;
  return { stdout: JSON.stringify(response), stderr: "" };
}

/** Builds a GhClient whose runner answers from in-memory route tables. */
function fakeGh(routes: FakeGhRoutes): (repoUrl: string) => GhClient {
  const runner: GhRunner = async (args) => {
    if (args[0] === "api" && args[1] === "graphql") return graphqlRoute(routes.graphql ?? {}, args);
    const simple = simpleRoutes(routes, args);
    if (simple !== undefined) return simple;
    const api = apiRoute(routes, args);
    if (api !== undefined) return api;
    throw new Error(`fake gh: unmatched invocation: gh ${args.join(" ")}`);
  };
  return () => new GhClient(runner);
}

/** Fake git options: clone recording plus the self-update probes. */
export interface FakeGitOptions {
  /** `git clone <url> <dest>` destinations are recorded here (project tests). */
  cloned?: Set<string>;
  /** `git rev-parse HEAD` → this sha (or fails when absent). */
  localSha?: string;
  /** `git remote get-url origin` → this URL (or fails when absent). */
  remoteUrl?: string;
  /** Forces `git rev-parse HEAD` to fail (no git repo at the checkout). */
  failRevParse?: boolean;
}

/**
 * Worker workspace preparation commands (issue #287): fetch, origin/HEAD
 * resolution, and worktree management. `null` when `args` is not one of them.
 */
function fakeWorkspaceGit(args: string[]): { stdout: string; stderr: string } | null {
  if (args[0] === "fetch") return { stdout: "", stderr: "" };
  if (args[0] === "worktree") return { stdout: "", stderr: "" };
  if (args[0] === "symbolic-ref" && args.includes("refs/remotes/origin/HEAD")) return { stdout: "origin/main\n", stderr: "" };
  return null;
}

 
/**
 * The one api-layer git fake, covering every command the daemon issues:
 * `clone` (recorded into `cloned`), `symbolic-ref --short HEAD`
 * (default-branch detection → `main`), and the self-update probes
 * `rev-parse HEAD` + `remote get-url origin`. Unmatched invocations throw.
 */
export function fakeGit(options: FakeGitOptions = {}): GitRunner {
  return async (args) => {
    if (args[0] === "clone") {
      const dest = args[args.length - 1] ?? "";
      options.cloned?.add(dest);
      mkdirSync(dest, { recursive: true });
      return { stdout: "", stderr: "" };
    }
    const workspace = fakeWorkspaceGit(args);
    if (workspace !== null) return workspace;
    if (args[0] === "symbolic-ref") return { stdout: "main\n", stderr: "" };
    if (args[0] === "rev-parse" && args[1] === "HEAD") {
      if (options.failRevParse || options.localSha === undefined) {
        throw new Error(`git ${args.join(" ")} failed`);
      }
      return { stdout: `${options.localSha}\n`, stderr: "" };
    }
    if (args[0] === "remote" && args[1] === "get-url" && args[2] === "origin") {
      if (options.remoteUrl === undefined) throw new Error(`git ${args.join(" ")} failed`);
      return { stdout: `${options.remoteUrl}\n`, stderr: "" };
    }
    throw new Error(`fake git: unmatched invocation: git ${args.join(" ")}`);
  };
}
 

export interface TestDaemon {
  services: DaemonServices;
  stateDir: string;
  tmux: FakeTmuxRunner;
  cloned: Set<string>;
}

/** Hermetic pi CLI runner for the default test daemon (no real pi spawn). */
const fakePiRunner: PiRunner = async () => ({ stdout: "", stderr: "" });

/** Builds a full daemon context over a tmp state dir with fake gh/git/tmux. */
export function testDaemon(
  ghRoutes: FakeGhRoutes = {},
  contextOptions: Partial<DaemonContextOptions> = {},
): TestDaemon {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pideck-api-"));
  const tmux = new FakeTmuxRunner();
  const cloned = new Set<string>();
  const services = createDaemonContext({
    stateDir,
    tmux: new Tmux({ runner: tmux.asRunner() }),
    gh: fakeGh(ghRoutes),
    git: fakeGit({ cloned }),
    // Hermetic default (issues #56/#57): pi auth ready without probing the
    // real CLI. Overridden by piRunner/piReady in the tests that exercise
    // the unauthenticated path. The fake runner also covers the pi version
    // memo (issue #223): a real `pi --version` spawn here would inject
    // environment-dependent latency into /api/status (issue #100).
    ...(contextOptions.piRunner === undefined && contextOptions.piReady === undefined
      ? { piReady: true, piRunner: fakePiRunner }
      : {}),
    ...(contextOptions.piRunner === undefined && contextOptions.piReady !== undefined
      ? { piRunner: fakePiRunner }
      : {}),
    promptGatePollIntervalMs: 0,
    // Issue #318 seam: hermetic fake panes count as ready — prompt-delivery
    // assertions keep their old single-send semantics. Tests exercising the
    // real readiness probe pass their own `paneReady` (or use the real-tmux
    // integration tests).
    paneReady: async () => true,
    ...contextOptions,
  });
  return { services, stateDir, tmux, cloned };
}
