/**
 * The fake gh binary as a test fixture. The script at `tools/fake-gh/gh` owns
 * the state semantics; this helper installs it on `PATH` as `gh`, seeds the
 * JSON state file, and exposes the small mutation API tests drive the loop
 * with (`setCI`, `addReview`, `assign`, `merge`, ...). Every mutation is a
 * write to the same state file the fake reads. The state is multi-repo:
 * mutations target the first registered repo by default and `fakeGh.repo(...)`
 * scopes a helper to any other one.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface FakeGhIssue {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  assignees: string[];
  labels: string[];
  blockedBy: number[];
}

export interface FakeGhReview {
  id: number;
  user: string;
  state: string;
  submitted_at: string;
  body: string | null;
  commit_id: string;
}

export interface FakeGhCheck {
  name: string;
  status: string;
  conclusion?: string | null;
  state?: string | null;
}

export interface FakeGhComment {
  id: number;
  user: string;
  body: string;
  created_at: string;
}

export interface FakeGhPr {
  number: number;
  headRefName: string;
  headRefOid: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: FakeGhCheck[];
  reviews: FakeGhReview[];
  reviewComments: FakeGhComment[];
  requestedReviewers: string[];
  body: string;
  state: "open" | "merged" | "closed";
}

/** One repo's slice of the fake GitHub state. */
export interface FakeGhRepo {
  issues: FakeGhIssue[];
  comments: Record<string, FakeGhComment[]>;
  prs: FakeGhPr[];
  /** The head SHA `gh api repos/<repo>/commits/<ref>` reports (update checks). */
  upstreamSha?: string | null;
}

export interface FakeGhState {
  seq: number;
  primaryLogin: string;
  tokens: Record<string, string>;
  repos: Record<string, FakeGhRepo>;
  invitations: { id: number; repo: string; invitee: string }[];
  readAccess: Record<string, string[]>;
}

export type FakeCi = "ok" | "pending" | "failed";
export type FakeReviewState = "APPROVED" | "CHANGES_REQUESTED";

export interface FakeGhOptions {
  repo: string;
  primaryLogin: string;
  reviewLogin: string;
  reviewToken: string;
}

/** The mutation surface of one repo, as `FakeGh` itself exposes for its default. */
export interface FakeGhRepoApi {
  state(): Promise<FakeGhRepo>;
  openIssue(number: number, title: string, assignees?: string[], blockedBy?: number[]): Promise<void>;
  setBlockedBy(issue: number, blockers: number[]): Promise<void>;
  assign(issue: number, login: string): Promise<void>;
  openPr(number: number, issue: number, headSha: string): Promise<void>;
  push(pr: number, headSha: string, ci?: { status: FakeCi; failingChecks?: string[] }): Promise<void>;
  setCI(pr: number, status: FakeCi, failingChecks?: string[]): Promise<void>;
  addReview(pr: number, reviewState: FakeReviewState, by: string, body?: string): Promise<number>;
  merge(pr: number): Promise<void>;
  addComment(number: number, author: string, body: string): Promise<number>;
}

export class FakeGh {
  readonly statePath: string;
  readonly binDir: string;
  readonly reviewToken: string;
  readonly defaultRepo: string;
  #previousPath: string;
  #previousStateEnv: string | undefined;

  constructor(options: FakeGhOptions) {
    this.binDir = mkdtempSync(join(tmpdir(), "pideck-fake-gh-bin-"));
    const bin = join(this.binDir, "gh");
    copyFileSync(fakeGhScriptPath(), bin);
    chmodSync(bin, 0o755);
    this.statePath = join(this.binDir, "state.json");
    this.reviewToken = options.reviewToken;
    this.defaultRepo = options.repo;
    const state: FakeGhState = {
      seq: 1000,
      primaryLogin: options.primaryLogin,
      tokens: { [options.reviewToken]: options.reviewLogin },
      repos: { [options.repo]: { issues: [], comments: {}, prs: [] } },
      invitations: [],
      readAccess: {},
    };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
    this.#previousPath = process.env.PATH ?? "";
    process.env.PATH = `${this.binDir}:${this.#previousPath}`;
    this.#previousStateEnv = process.env.FAKE_GH_STATE;
    process.env.FAKE_GH_STATE = this.statePath;
  }

  /** The full state, exactly as the fake serves it. */
  async state(): Promise<FakeGhState> {
    return JSON.parse(await this.op("state")) as FakeGhState;
  }

  /** A helper whose mutations target one specific repo. */
  repo(name: string): FakeGhRepoApi {
    return {
      state: () => this.repoState(name),
      openIssue: async (number, title, assignees = [], blockedBy = []) => {
        await this.repoOp(name, "openIssue", { number, title, assignees, blockedBy });
      },
      setBlockedBy: async (issue, blockers) => {
        await this.repoOp(name, "setBlockedBy", { issue, blockers });
      },
      assign: async (issue, login) => {
        await this.repoOp(name, "assign", { issue, login });
      },
      openPr: async (number, issue, headSha) => {
        await this.repoOp(name, "openPr", { number, issue, headSha });
      },
      push: async (pr, headSha, ci) => {
        await this.repoOp(name, "push", { pr, headSha, ci });
      },
      setCI: async (pr, status, failingChecks = []) => {
        await this.repoOp(name, "setCI", { pr, status, failingChecks });
      },
      addReview: async (pr, reviewState, by, body) => {
        const result = JSON.parse(
          await this.repoOp(name, "addReview", { pr, reviewState, by, body }),
        ) as { id: number };
        return result.id;
      },
      merge: async (pr) => {
        await this.repoOp(name, "merge", { pr });
      },
      addComment: async (number, author, body) => {
        const result = JSON.parse(
          await this.repoOp(name, "addComment", { number, author, body }),
        ) as { id: number };
        return result.id;
      },
    };
  }

  /** Registers an additional repo so its issues and PRs can be seeded. */
  async addRepo(name: string): Promise<void> {
    await this.op("addRepo", { repo: name });
  }

  async openIssue(
    number: number,
    title: string,
    assignees: string[] = [],
    blockedBy: number[] = [],
  ): Promise<void> {
    await this.op("openIssue", { number, title, assignees, blockedBy });
  }

  async setBlockedBy(issue: number, blockers: number[]): Promise<void> {
    await this.op("setBlockedBy", { issue, blockers });
  }

  async assign(issue: number, login: string): Promise<void> {
    await this.op("assign", { issue, login });
  }

  async openPr(number: number, issue: number, headSha: string): Promise<void> {
    await this.op("openPr", { number, issue, headSha });
  }

  async push(pr: number, headSha: string, ci?: { status: FakeCi; failingChecks?: string[] }): Promise<void> {
    await this.op("push", { pr, headSha, ci });
  }

  async setCI(pr: number, status: FakeCi, failingChecks: string[] = []): Promise<void> {
    await this.op("setCI", { pr, status, failingChecks });
  }

  async addReview(pr: number, reviewState: FakeReviewState, by: string, body?: string): Promise<number> {
    const result = JSON.parse(await this.op("addReview", { pr, reviewState, by, body })) as {
      id: number;
    };
    return result.id;
  }

  async merge(pr: number): Promise<void> {
    await this.op("merge", { pr });
  }

  async addComment(number: number, author: string, body: string): Promise<number> {
    const result = JSON.parse(await this.op("addComment", { number, author, body })) as { id: number };
    return result.id;
  }

  /** Restores PATH/FAKE_GH_STATE and removes the temp binary dir. */
  dispose(): void {
    if (this.#previousPath === "") delete process.env.PATH;
    else process.env.PATH = this.#previousPath;
    if (this.#previousStateEnv === undefined) delete process.env.FAKE_GH_STATE;
    else process.env.FAKE_GH_STATE = this.#previousStateEnv;
    rmSync(this.binDir, { recursive: true, force: true });
  }

  async op(name: string, payload: Record<string, unknown> = {}): Promise<string> {
    return this.execOp(name, payload);
  }

  private async repoOp(repo: string, name: string, payload: Record<string, unknown>): Promise<string> {
    return this.execOp(name, { ...payload, repo });
  }

  private async repoState(repo: string): Promise<FakeGhRepo> {
    return JSON.parse(await this.execOp("repoState", { repo })) as FakeGhRepo;
  }

  private async execOp(name: string, payload: Record<string, unknown>): Promise<string> {
    const result = await execFileP(
      process.execPath,
      [join(this.binDir, "gh"), "__op", name, JSON.stringify(payload)],
      { env: { ...process.env, FAKE_GH_STATE: this.statePath } },
    );
    return result.stdout;
  }
}

/** Locates `tools/fake-gh/gh` by walking up from this module. */
function fakeGhScriptPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "tools", "fake-gh", "gh");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Cannot locate tools/fake-gh/gh from the e2e directory");
    }
    dir = parent;
  }
}
