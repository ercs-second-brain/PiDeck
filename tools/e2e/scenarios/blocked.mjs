import {
  assignIssue,
  commentOnIssue,
  createIssue,
  issueComments,
  issueView,
  prByHead,
  prCi,
  setIssueBody,
} from "../lib/gh.mjs";
import { workerFor } from "../lib/views.mjs";

/**
 * blocked — the blocker channel: an issue whose task needs a decision the
 * worker cannot make, pointing at a private style-guide repo no account on
 * the fixture repo can read. Assign, then wait for the worker's `BLOCKED:`
 * comment on the issue, answer it as the user would (a decision comment),
 * and assert the worker wakes, opens the PR, and the loop completes:
 * CI green → approved → merged → issue closed.
 */

const blockedBody = (n) => `## Task

\`test/greeting.test.js\` is failing on main because \`src/greeting.js\` returns
\`"TODO"\`. Implement \`greeting()\` so the test passes.

## Why this needs a decision first

The wording of \`greeting()\` is a product decision. It was changed away from the
wording the test's literal happens to show — the current wording is recorded in the
private repo \`ercs-second-brain/style-guide\` (file \`wording.md\`), which no account
on this repo can read. Treat the test's literal as stale, not as a spec: do not copy
it and do not invent a wording.

## What to do

Read the style guide to learn the wording, then implement it. If you cannot read the
style guide, comment on this issue with a line starting \`BLOCKED:\` that says what
decision you need, then go idle. When the decision arrives as a comment on this issue,
implement it and open a PR from \`pideck/issue-${n}\` with \`Closes #${n}\`.
`;

const decisionBody = (n) => `Decision: the wording is \`"Hello, PiDeck!"\` — the style guide was
updated and the wording moved back to what the failing test already shows. Implement
\`greeting()\` accordingly and open a PR from \`pideck/issue-${n}\` with \`Closes #${n}\`.
`;

const headRef = (n) => `pideck/issue-${n}`;

export async function run(ctx) {
  const { until, repoFull, primary } = ctx;

  const a = await createIssue(repoFull, { title: "Make the failing test pass", body: blockedBody("n") });
  await setIssueBody(repoFull, a, blockedBody(a));
  await assignIssue(repoFull, a, primary);

  await until(`worker spawned for issue #${a}`, () => ctx.sessions().then((all) => workerFor(all, a)));
  await until(`BLOCKED: comment on #${a}`, async () =>
    (await issueComments(repoFull, a)).some((c) => c.body.trimStart().startsWith("BLOCKED:")));
  await commentOnIssue(repoFull, a, decisionBody(a));

  const pr = await until(`PR opened for #${a} after the decision`, () => prByHead(repoFull, headRef(a)));
  await until(`PR #${pr.number} CI green`, async () => prCi(await prByHead(repoFull, headRef(a))) === "ok");
  await until(
    `PR #${pr.number} approved`,
    async () => (await prByHead(repoFull, headRef(a))).reviewDecision === "APPROVED",
  );
  await until(`PR #${pr.number} merged`, async () => (await prByHead(repoFull, headRef(a))).state === "MERGED");
  await until(`issue #${a} closed`, async () => (await issueView(repoFull, a)).state === "CLOSED");
}
