/**
 * The session-aware CLI verbs: pr open, review, reply, blocked, followup,
 * threads, resolve. Each resolves the caller's session from PD_SESSION_ID
 * through the daemon's context endpoint, then shells out to `gh` (and git)
 * with the pane's own environment — so every action runs as the pane's GitHub
 * identity and inside the session's clone, and agents never hand-build the
 * incantations.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import type { SessionContext } from "@pideck/shared";

export type VerbGh = (args: string[], input?: string) => Promise<string>;
export type VerbGit = (args: string[]) => Promise<string>;

/** The slice of CliIo the verbs run against; gh/git overridable for tests. */
export interface VerbCliIo {
  url: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  gh?: VerbGh;
  git?: VerbGit;
}

export interface VerbIo {
  env: NodeJS.ProcessEnv;
  daemonUrl: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  gh: VerbGh;
  git: VerbGit;
}

export function defaultVerbIo(
  base: Omit<VerbIo, "gh" | "git"> & Partial<Pick<VerbIo, "gh" | "git">>,
): VerbIo {
  return {
    ...base,
    gh: base.gh ?? defaultGhExec(base.env),
    git: base.git ?? defaultGitExec,
  };
}

function defaultGhExec(env: NodeJS.ProcessEnv): VerbGh {
  return (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "gh",
        args,
        { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as { stderr?: string };
            reject(new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${(e.stderr || stderr || err.message).trim()}`));
            return;
          }
          resolve(stdout);
        },
      );
      child.stdin?.end(input ?? "");
    });
}

function defaultGitExec(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, (err, stdout, stderr) => {
      if (err) {
        const e = err as { stderr?: string };
        reject(new Error(`git ${args[0]} failed: ${(e.stderr || stderr || err.message).trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** The session's GitHub facts, resolved by the daemon from the registry. */
export async function sessionContext(io: VerbIo): Promise<SessionContext> {
  const id = io.env.PD_SESSION_ID;
  if (!id) throw new Error("not in a session: PD_SESSION_ID is unset");
  const res = await fetch(`${io.daemonUrl}/api/sessions/${encodeURIComponent(id)}/context`);
  if (res.status === 404) throw new Error(`unknown session: ${id}`);
  if (!res.ok) throw new Error(`context lookup failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as SessionContext;
}

async function ghJson<T>(io: VerbIo, args: string[], input?: string): Promise<T> {
  return JSON.parse(await io.gh(args, input)) as T;
}

function prUrl(ctx: SessionContext): string {
  return `https://github.com/${ctx.repo}/pull/${ctx.prNumber}`;
}

function issueUrl(ctx: SessionContext, number: number): string {
  return `https://github.com/${ctx.repo}/issues/${number}`;
}

function requireIssue(ctx: SessionContext): number {
  if (ctx.issueNumber === null) throw new Error("this session has no issue — it cannot run this verb");
  return ctx.issueNumber;
}

function requirePr(ctx: SessionContext): number {
  if (ctx.prNumber === null) throw new Error("this session has no PR — it cannot run this verb");
  return ctx.prNumber;
}

/** First https URL on the output — gh prints the PR URL on its own line. */
function urlFrom(stdout: string): string | null {
  return stdout.match(/https:\/\/[^\s]+/)?.[0] ?? null;
}

async function issueTitle(io: VerbIo, ctx: SessionContext, issue: number): Promise<string> {
  const raw = await ghJson<{ title?: string }>(
    io,
    ["api", `repos/${ctx.repo}/issues/${issue}`],
  );
  return raw.title ?? `issue #${issue}`;
}

/** Appends `Closes #n` unless the body already references the issue. */
function withCloses(body: string, issue: number): string {
  const trimmed = body.trimEnd();
  if (new RegExp(`(?:closes|fixes|resolves) #${issue}\\b`, "i").test(trimmed)) return trimmed;
  return `${trimmed}\n\nCloses #${issue}`;
}

export interface PrOpenOptions {
  title?: string;
  body?: string;
  bodyFile?: string;
}

/**
 * Opens (or finds) the session's PR: pushes the branch, appends
 * `Closes #<issue>` to the body, and prints the PR URL — a no-op printing the
 * URL when the branch already has an open PR.
 */
export async function prOpen(io: VerbIo, opts: PrOpenOptions): Promise<void> {
  const ctx = await sessionContext(io);
  const issue = requireIssue(ctx);
  const branch = ctx.branch ?? `pideck/issue-${issue}`;
  const existing = await ghJson<{ number: number; url: string }[]>(io, [
    "pr", "list", "--repo", ctx.repo, "--head", branch, "--state", "open", "--json", "number,url",
  ]);
  if (existing.length > 0) {
    io.stdout(existing[0]!.url);
    return;
  }
  let body = opts.body ?? "";
  if (opts.bodyFile !== undefined) body = readFileSync(opts.bodyFile, "utf8");
  const title = opts.title ?? (await issueTitle(io, ctx, issue));
  await io.git(["push", "-u", "origin", branch]);
  const out = await io.gh([
    "pr", "create", "--repo", ctx.repo, "--base", ctx.defaultBranch, "--head", branch,
    "--title", title, "--body", withCloses(body, issue),
  ]);
  io.stdout(urlFrom(out) ?? prUrl(ctx));
}

export interface InlineComment {
  file: string;
  line?: number;
  body: string;
}

export type ReviewVerdict = "approve" | "request-changes" | "comment";

/** Files exactly one review; inline comments ride on the same review. */
export async function review(
  io: VerbIo,
  opts: { verdict: ReviewVerdict; body?: string; comments: InlineComment[] },
): Promise<void> {
  const ctx = await sessionContext(io);
  const pr = requirePr(ctx);
  const event =
    opts.verdict === "approve" ? "APPROVE"
    : opts.verdict === "request-changes" ? "REQUEST_CHANGES"
    : "COMMENT";
  const payload = {
    event,
    body: opts.body ?? "",
    comments: opts.comments.map((c) => ({ path: c.file, line: c.line, body: c.body })),
  };
  await io.gh(
    ["api", "--method", "POST", `repos/${ctx.repo}/pulls/${pr}/reviews`, "--input", "-"],
    JSON.stringify(payload),
  );
  io.stdout(prUrl(ctx));
}

const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){" +
  "pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path line " +
  "comments(first:1){nodes{body}}}}}}}";

/** Lists the PR's review threads: id, path:line, first comment, resolved flag. */
export async function threads(io: VerbIo): Promise<void> {
  const ctx = await sessionContext(io);
  const pr = requirePr(ctx);
  const [owner, name] = ctx.repo.split("/");
  const raw = await ghJson<GhThreadsResponse>(io, [
    "api", "graphql", "-f", `query=${THREADS_QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${pr}`,
  ]);
  for (const node of raw.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
    const where = node.path === null ? "-" : `${node.path}:${node.line ?? "?"}`;
    io.stdout(`${node.id}  ${where}  ${node.isResolved ? "resolved" : "open"}  ${node.comments.nodes[0]?.body ?? ""}`);
  }
}

interface GhThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: { id: string; isResolved: boolean; path: string | null; line: number | null; comments: { nodes: { body: string }[] } }[];
        };
      };
    };
  };
}

/** Resolves one review thread by its GraphQL id. */
export async function resolveThread(io: VerbIo, threadId: string): Promise<void> {
  const ctx = await sessionContext(io);
  requirePr(ctx);
  const raw = await ghJson<{ data?: { resolveReviewThread?: { thread?: { isResolved?: boolean } } } }>(
    io,
    ["api", "graphql", "-f", "query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}", "-f", `id=${threadId}`],
  );
  if (!raw.data?.resolveReviewThread?.thread?.isResolved) {
    throw new Error(`gh did not confirm resolution of thread ${threadId}`);
  }
  io.stdout(`${prUrl(ctx)} — thread ${threadId} resolved`);
}

/** Replies in a review thread; prints the comment's discussion URL. */
export async function reply(io: VerbIo, commentId: string, body: string): Promise<void> {
  const ctx = await sessionContext(io);
  const pr = requirePr(ctx);
  const raw = await ghJson<{ id: number }>(io, [
    "api", "--method", "POST", `repos/${ctx.repo}/pulls/${pr}/comments/${commentId}/replies`,
    "-f", `body=${body}`,
  ]);
  io.stdout(`${prUrl(ctx)}#discussion_r${raw.id}`);
}

/** Posts `BLOCKED: <body>` on the session's issue, then reminds to end the turn. */
export async function blocked(io: VerbIo, body: string): Promise<void> {
  const ctx = await sessionContext(io);
  const issue = requireIssue(ctx);
  const raw = await ghJson<{ id: number }>(io, [
    "api", "--method", "POST", `repos/${ctx.repo}/issues/${issue}/comments`,
    "-f", `body=BLOCKED: ${body}`,
  ]);
  io.stdout(`${issueUrl(ctx, issue)}#issuecomment-${raw.id}`);
  io.stdout("Your blocker is on GitHub — end the turn now; the orchestrator wakes you on reply.");
}

/** Appends a bullet under `## Follow-ups` in the PR body (creating it if missing). */
export async function followup(io: VerbIo, body: string): Promise<void> {
  const ctx = await sessionContext(io);
  const pr = requirePr(ctx);
  const current = await ghJson<{ body?: string | null }>(io, ["api", `repos/${ctx.repo}/pulls/${pr}`]);
  await io.gh([
    "api", "--method", "PATCH", `repos/${ctx.repo}/pulls/${pr}`,
    "-f", `body=${withFollowup(current.body ?? "", body)}`,
  ]);
  io.stdout(prUrl(ctx));
}

function withFollowup(body: string, bullet: string): string {
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Follow-ups");
  const entry = `- ${bullet.trim()}`;
  if (heading === -1) {
    const trimmed = body.trimEnd();
    return `${trimmed}${trimmed ? "\n\n" : ""}## Follow-ups\n\n${entry}`;
  }
  let end = heading + 1;
  while (end < lines.length && !lines[end]!.startsWith("## ")) end++;
  while (end > heading + 1 && lines[end - 1]!.trim() === "") end--;
  lines.splice(end, 0, entry);
  return lines.join("\n");
}

/** The first value after the given flag, if present. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Handles one session verb (pr, review, reply, blocked, followup, threads,
 * resolve); returns null when args is not one, so the plain CLI dispatch can
 * fall through. `usageError` reports flag mistakes with the full usage text.
 */
export async function runVerbCommand(
  argv: string[],
  cli: VerbCliIo,
  usageError: (message: string) => number,
): Promise<number | null> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "pr": {
      const [sub] = rest;
      if (sub !== "open") return usageError(`unknown pr command: ${sub ?? ""}`);
      const body = flag(rest, "--body");
      const bodyFile = flag(rest, "--body-file");
      if (body !== undefined && bodyFile !== undefined) {
        return usageError("pr open takes --body or --body-file, not both");
      }
      await prOpen(verbIo(cli), { title: flag(rest, "--title"), body, bodyFile });
      return 0;
    }

    case "review": {
      const [verdict, ...inline] = rest;
      if (verdict !== "approve" && verdict !== "request-changes" && verdict !== "comment") {
        return usageError("review needs a verdict: approve, request-changes, or comment");
      }
      const { body, comments } = parseReviewArgs(inline);
      await review(verbIo(cli), { verdict, body, comments });
      return 0;
    }

    case "reply": {
      const [commentId] = rest;
      const body = flag(rest, "--body");
      if (!commentId || commentId.startsWith("--") || !body) {
        return usageError("reply needs a comment id and --body");
      }
      await reply(verbIo(cli), commentId, body);
      return 0;
    }

    case "blocked": {
      const body = flag(rest, "--body");
      if (!body) return usageError("blocked needs --body");
      await blocked(verbIo(cli), body);
      return 0;
    }

    case "followup": {
      const body = flag(rest, "--body");
      if (!body) return usageError("followup needs --body");
      await followup(verbIo(cli), body);
      return 0;
    }

    case "threads":
      await threads(verbIo(cli));
      return 0;

    case "resolve": {
      const [threadId] = rest;
      if (!threadId || threadId.startsWith("--")) {
        return usageError("resolve needs a thread id (see pideck threads)");
      }
      await resolveThread(verbIo(cli), threadId);
      return 0;
    }

    default:
      return null;
  }
}

/** Builds a VerbIo from the CLI's io, with test-overridable gh/git runners. */
function verbIo(io: VerbCliIo): VerbIo {
  return defaultVerbIo({
    env: io.env ?? process.env,
    daemonUrl: io.url,
    stdout: io.stdout,
    stderr: io.stderr,
    gh: io.gh,
    git: io.git,
  });
}

/**
 * Parses review flags: the first --body before any --file is the review's
 * summary body; each --file starts an inline comment (--line, then --body).
 */
function parseReviewArgs(args: string[]): { body?: string; comments: InlineComment[] } {
  const comments: InlineComment[] = [];
  let body: string | undefined;
  let current: InlineComment | null = null;
  let currentNeedsBody = false;
  const closeCurrent = (): void => {
    if (currentNeedsBody) throw new Error("each inline comment needs --body");
  };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    switch (args[i]) {
      case "--body":
        if (current === null) body = value;
        else {
          current.body = value ?? "";
          currentNeedsBody = false;
        }
        i++;
        break;
      case "--file":
        closeCurrent();
        current = { file: value ?? "", body: "" };
        currentNeedsBody = true;
        comments.push(current);
        i++;
        break;
      case "--line": {
        if (current === null) throw new Error("--line needs a preceding --file");
        const line = Number(value);
        if (!Number.isInteger(line) || line <= 0) {
          throw new Error(`--line must be a positive integer, got: ${value}`);
        }
        current.line = line;
        i++;
        break;
      }
      default:
        throw new Error(`unknown review flag: ${args[i]}`);
    }
  }
  closeCurrent();
  return { body, comments };
}
