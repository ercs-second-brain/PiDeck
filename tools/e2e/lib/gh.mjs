import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/**
 * `gh` facts for the e2e scenarios. Every call runs the real `gh` CLI; an
 * identity other than the primary is selected with GH_TOKEN in the env
 * override — never on the command line, so a token never lands in an error
 * message or a log. Fact helpers return plain parsed JSON the scenarios
 * assert on with `until`.
 */

export async function gh(args, env = {}) {
  const result = await execFileP("gh", args, {
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}

export async function ghJson(args, env = {}) {
  return JSON.parse(await gh(args, env));
}

export const PR_FIELDS =
  "number,headRefName,headRefOid,state,mergeable,mergedAt,reviewDecision,statusCheckRollup,url";

/** The open-or-merged PR on a branch, or null before it exists. */
export async function prByHead(repoFull, headRef) {
  const prs = await ghJson(
    ["pr", "list", "--repo", repoFull, "--state", "all", "--head", headRef, "--json", PR_FIELDS],
  );
  return prs.at(0) ?? null;
}

/** The GitHub issue's id, needed for `blocked by` dependency links. */
export async function issueGhId(repoFull, number) {
  const raw = await ghJson(["api", `repos/${repoFull}/issues/${number}`]);
  return raw.id;
}

/** Every review on the PR: id, verdict, the head it was filed at, author. */
export async function prReviews(repoFull, number) {
  const raw = await ghJson(["api", `repos/${repoFull}/pulls/${number}/reviews?per_page=100`]);
  return raw.map((r) => ({
    id: r.id,
    state: r.state,
    commitId: r.commit_id,
    author: r.user?.login ?? null,
  }));
}

/** The PR's inline review comments: id, review, author, path, line. */
export async function prReviewComments(repoFull, number) {
  const raw = await ghJson(["api", `repos/${repoFull}/pulls/${number}/comments?per_page=100`]);
  return raw.map((c) => ({
    id: c.id,
    reviewId: c.pull_request_review_id,
    author: c.user?.login ?? null,
    path: c.path,
    line: c.line ?? c.original_line ?? null,
  }));
}

export async function issueView(repoFull, number) {
  return ghJson([
    "issue", "view", String(number), "--repo", repoFull,
    "--json", "number,state,title,url,assignees",
  ]);
}

export async function issueComments(repoFull, number) {
  return ghJson(["api", `repos/${repoFull}/issues/${number}/comments?per_page=100`]);
}

export async function blockedBy(repoFull, number) {
  return ghJson(["api", `repos/${repoFull}/issues/${number}/dependencies/blocked_by`]);
}

export async function createIssue(repoFull, { title, body }) {
  const url = await gh(["issue", "create", "--repo", repoFull, "--title", title, "--body", body]);
  return Number(url.trim().match(/\/issues\/(\d+)$/)[1]);
}

/** A body that names the issue's own number needs one edit after creation. */
export async function setIssueBody(repoFull, number, body) {
  await gh(["issue", "edit", String(number), "--repo", repoFull, "--body", body]);
}

export async function assignIssue(repoFull, number, login) {
  await gh(["issue", "edit", String(number), "--repo", repoFull, "--add-assignee", login]);
}

/** Links `number` as blocked by `blocker` via GitHub issue dependencies. */
export async function linkBlockedBy(repoFull, number, blockerGhId) {
  // -F keeps issue_id a JSON number, as the API's schema wants.
  await gh(["api", "--method", "POST", `repos/${repoFull}/issues/${number}/dependencies/blocked_by`,
    "-F", `issue_id=${blockerGhId}`]);
}

export async function commentOnIssue(repoFull, number, body) {
  const raw = await ghJson(["api", "--method", "POST", `repos/${repoFull}/issues/${number}/comments`,
    "-f", `body=${body}`]);
  return raw.id;
}

export async function primaryLogin() {
  const raw = await ghJson(["api", "user"]);
  return raw.login;
}

/** The login a PAT belongs to; the token is passed by env, never printed. */
export async function loginForToken(token) {
  const raw = await ghJson(["api", "user"], { GH_TOKEN: token });
  return raw.login;
}

// The same rollup rule as the daemon's GitHub client: pending contexts hold
// the verdict, a done non-SUCCESS check fails it.
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

function checkDone(check) {
  return check.conclusion !== undefined && check.conclusion !== null
    || check.state !== undefined && check.state !== null && !PENDING_STATES.has(check.state);
}

function checkOk(check) {
  return check.conclusion === "SUCCESS" || check.state === "SUCCESS";
}

export function prChecks(pr) {
  return pr?.statusCheckRollup ?? [];
}

export function prCi(pr) {
  const checks = prChecks(pr);
  if (checks.some((c) => checkDone(c) && !checkOk(c))) return "failed";
  return checks.some((c) => !checkDone(c)) ? "pending" : checks.length === 0 ? "none" : "ok";
}
