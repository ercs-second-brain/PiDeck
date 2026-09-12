/**
 * The fake gh binary as a test fixture. The script at `tools/fake-gh/gh` owns
 * the state semantics; this helper installs it on `PATH` as `gh`, seeds the
 * JSON state file, and exposes the small mutation API tests drive the loop
 * with (`setCI`, `addReview`, `assign`, `merge`, ...). Every mutation is a
 * write to the same state file the fake reads.
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

export interface FakeGhState {
  seq: number;
  repo: string;
  primaryLogin: string;
  tokens: Record<string, string>;
  issues: FakeGhIssue[];
  comments: Record<string, FakeGhComment[]>;
  prs: FakeGhPr[];
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

export class FakeGh {
  readonly statePath: string;
  readonly binDir: string;
  readonly reviewToken: string;
  #previousPath: string;
  #previousStateEnv: string | undefined;

  constructor(options: FakeGhOptions) {
    this.binDir = mkdtempSync(join(tmpdir(), "pideck-fake-gh-bin-"));
    const bin = join(this.binDir, "gh");
    copyFileSync(fakeGhScriptPath(), bin);
    chmodSync(bin, 0o755);
    this.statePath = join(this.binDir, "state.json");
    this.reviewToken = options.reviewToken;
    const state: FakeGhState = {
      seq: 1000,
      repo: options.repo,
      primaryLogin: options.primaryLogin,
      tokens: { [options.reviewToken]: options.reviewLogin },
      issues: [],
      comments: {},
      prs: [],
      invitations: [],
      readAccess: {},
    };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf8");
    this.#previousPath = process.env.PATH ?? "";
    process.env.PATH = `${this.binDir}:${this.#previousPath}`;
    this.#previousStateEnv = process.env.FAKE_GH_STATE;
    process.env.FAKE_GH_STATE = this.statePath;
  }

  /** The current repo state, exactly as the fake serves it. */
  async state(): Promise<FakeGhState> {
    return JSON.parse(await this.op("state")) as FakeGhState;
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
