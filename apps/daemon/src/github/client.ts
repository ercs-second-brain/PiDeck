import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Probe } from "@pideck/shared";
import { ProbeSchema } from "@pideck/shared";
import { z, type ZodType } from "zod";
import { GhError } from "./error.js";
import {
  ciRollup,
  commentsSince,
  toComment,
  toReview,
  GhApiCommentSchema,
  GhBlockerSchema,
  GhBodySchema,
  GhCommentIdSchema,
  GhIssueSchema,
  GhPrSchema,
  GhReviewSchema,
  type GhComment,
  type GhIssue,
  type GhPr,
  type GhReview,
} from "./schemas.js";

const execFileP = promisify(execFile);
const LIST_LIMIT = "100";

export type GhExecResult = { stdout: string; stderr: string; exitCode: number };
export type GhExec = (args: string[], env: NodeJS.ProcessEnv) => Promise<GhExecResult>;

export type GhClientOptions = {
  repo: string;
  token?: string;
  exec?: GhExec;
};

async function defaultExec(args: string[], env: NodeJS.ProcessEnv): Promise<GhExecResult> {
  try {
    const { stdout, stderr } = await execFileP("gh", args, { env, maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
}

export class GhClient {
  private readonly repo: string;
  private readonly token: string | undefined;
  private readonly exec: GhExec;

  constructor(options: GhClientOptions) {
    this.repo = options.repo;
    this.token = options.token;
    this.exec = options.exec ?? defaultExec;
  }

  private async run(args: string[]): Promise<string> {
    const result = await this.exec(args, this.env());
    if (result.exitCode !== 0) throw new GhError(args.join(" "), result.stderr, result.exitCode);
    return result.stdout;
  }

  private async runJson<T>(schema: ZodType<T>, args: string[]): Promise<T> {
    const stdout = await this.run(args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new GhError(args.join(" "), `stdout is not JSON: ${stdout.slice(0, 200)}`, null);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new GhError(args.join(" "), z.prettifyError(result.error), null);
    }
    return result.data;
  }

  async openIssues(): Promise<GhIssue[]> {
    const raw = await this.runJson(
      z.array(GhIssueSchema),
      ["issue", "list", "--repo", this.repo, "--state", "open", "--limit", LIST_LIMIT,
        "--json", "number,title,url,assignees,labels"],
    );
    return raw.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      assignees: issue.assignees.map((u) => u.login),
      labels: issue.labels.map((l) => l.name),
    }));
  }

  async blockedBy(issueNumber: number): Promise<{ number: number; state: "open" | "closed" }[]> {
    const raw = await this.runJson(
      z.array(GhBlockerSchema),
      ["api", `repos/${this.repo}/issues/${issueNumber}/dependencies/blocked_by`],
    );
    return raw;
  }

  async issueComments(issueNumber: number, sinceId?: number): Promise<GhComment[]> {
    const raw = await this.runJson(
      z.array(GhApiCommentSchema),
      ["api", `repos/${this.repo}/issues/${issueNumber}/comments?per_page=${LIST_LIMIT}`],
    );
    return commentsSince(raw.map(toComment), sinceId);
  }

  async openPrs(): Promise<GhPr[]> {
    const raw = await this.runJson(
      z.array(GhPrSchema),
      ["pr", "list", "--repo", this.repo, "--state", "open", "--limit", LIST_LIMIT,
        "--json", "number,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup"],
    );
    return raw.map((pr) => {
      const rollup = ciRollup(pr.statusCheckRollup);
      return {
        number: pr.number,
        headBranch: pr.headRefName,
        headSha: pr.headRefOid,
        mergeable: pr.mergeable,
        reviewDecision: pr.reviewDecision,
        ciStatus: rollup.ciStatus,
        failingChecks: rollup.failingChecks,
      };
    });
  }

  async prReviews(prNumber: number): Promise<GhReview[]> {
    const raw = await this.runJson(
      z.array(GhReviewSchema),
      ["api", `repos/${this.repo}/pulls/${prNumber}/reviews`],
    );
    return raw.map(toReview);
  }

  async prReviewComments(prNumber: number, sinceId?: number): Promise<GhComment[]> {
    const raw = await this.runJson(
      z.array(GhApiCommentSchema),
      ["api", `repos/${this.repo}/pulls/${prNumber}/comments?per_page=${LIST_LIMIT}`],
    );
    return commentsSince(raw.map(toComment), sinceId);
  }

  async prBody(prNumber: number): Promise<string> {
    const raw = await this.runJson(
      GhBodySchema,
      ["api", `repos/${this.repo}/pulls/${prNumber}`],
    );
    return raw.body ?? "";
  }

  async authStatus(): Promise<Probe> {
    const result = await this.exec(["auth", "status"], this.env());
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim() || "not logged in";
      return ProbeSchema.parse({ ok: false, detail });
    }
    const match = result.stdout.match(/account\s+([A-Za-z0-9-]+)/);
    const detail = match === null ? "logged in" : `logged in as ${match[1]}`;
    return ProbeSchema.parse({ ok: true, detail });
  }

  async assignIssue(issueNumber: number, login: string): Promise<void> {
    await this.run(["issue", "edit", String(issueNumber), "--repo", this.repo, "--add-assignee", login]);
  }

  async unassignIssue(issueNumber: number, login: string): Promise<void> {
    await this.run(["issue", "edit", String(issueNumber), "--repo", this.repo, "--remove-assignee", login]);
  }

  async addIssueComment(issueNumber: number, body: string): Promise<number> {
    const raw = await this.runJson(
      GhCommentIdSchema,
      ["api", "--method", "POST", `repos/${this.repo}/issues/${issueNumber}/comments`, "-f", `body=${body}`],
    );
    return raw.id;
  }

  async addPrComment(prNumber: number, body: string): Promise<number> {
    const raw = await this.runJson(
      GhCommentIdSchema,
      ["api", "--method", "POST", `repos/${this.repo}/issues/${prNumber}/comments`, "-f", `body=${body}`],
    );
    return raw.id;
  }

  async mergePr(prNumber: number): Promise<void> {
    await this.run(["pr", "merge", String(prNumber), "--repo", this.repo, "--squash", "--delete-branch"]);
  }

  /** True when this client's account can read the repo (exit 0 on the repo endpoint). */
  async hasReadAccess(): Promise<boolean> {
    try {
      await this.run(["api", `repos/${this.repo}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** Invites `login` as a collaborator with push, run as the primary account. */
  async inviteCollaborator(login: string): Promise<void> {
    await this.run([
      "api", "--method", "PUT", `repos/${this.repo}/collaborators/${login}`, "-f", "permission=push",
    ]);
  }

  /** Accepts this account's pending repository invitations; returns how many. */
  async acceptInvitations(): Promise<number> {
    const raw = await this.runJson(
      z.array(z.object({ id: z.number() })),
      ["api", "/user/repository_invitations"],
    );
    for (const invitation of raw) {
      await this.run(["api", "--method", "PATCH", `/user/repository_invitations/${invitation.id}`]);
    }
    return raw.length;
  }

  async requestReview(prNumber: number, login: string): Promise<void> {
    await this.run(["pr", "edit", String(prNumber), "--repo", this.repo, "--add-reviewer", login]);
  }

  private env(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.token !== undefined) env.GH_TOKEN = this.token;
    return env;
  }
}
