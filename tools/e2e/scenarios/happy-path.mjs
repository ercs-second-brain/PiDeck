import {
  assignIssue,
  blockedBy,
  createIssue,
  issueGhId,
  issueView,
  linkBlockedBy,
  prByHead,
  prCi,
  setIssueBody,
} from "../lib/gh.mjs";
import { workerFor } from "../lib/views.mjs";

/**
 * happy-path — the SPEC §2 table from assignment to merge and unblocking:
 * a failing test on main, an issue asking for the fix, a dependent issue
 * blocked by it. Assign both, then assert on GitHub facts (plus one check
 * on /api/sessions for the spawn): PR opened → CI green → approved →
 * merged → issue closed → the dependent's worker spawns.
 */

const fixBody = (n) => `## Task

\`test/greeting.test.js\` is failing on main because \`src/greeting.js\` still returns
\`"TODO"\`. Implement \`greeting()\` so the test passes. The wording is the product's:
\`Hello, PiDeck!\`.

Open a PR from \`pideck/issue-${n}\` with \`Closes #${n}\`.
`;

const dependentBody = (n) => `## Task

Extend \`src/greeting.js\` with \`audience(name)\` that returns the existing
\`greeting()\` followed by \` — \` and the name, e.g. \`Hello, PiDeck! — Ada\`.
Add a passing \`node --test\` covering it.

Open a PR from \`pideck/issue-${n}\` with \`Closes #${n}\`.
`;

const headRef = (n) => `pideck/issue-${n}`;

export async function run(ctx) {
  const { until, repoFull, primary } = ctx;

  const a = await createIssue(repoFull, { title: "Implement greeting()", body: fixBody("n") });
  await setIssueBody(repoFull, a, fixBody(a));
  const b = await createIssue(repoFull, { title: "Add audience(name)", body: dependentBody("n") });
  await setIssueBody(repoFull, b, dependentBody(b));
  await assignIssue(repoFull, a, primary);
  await assignIssue(repoFull, b, primary);
  await linkBlockedBy(repoFull, b, await issueGhId(repoFull, a));

  await until(`worker spawned for issue #${a}`, () => ctx.sessions().then((all) => workerFor(all, a)));
  await until(`#${b} shows #${a} as an open blocker`, async () => {
    const blockers = await blockedBy(repoFull, b);
    return blockers.some((x) => x.number === a && x.state === "open");
  });

  const pr = await until(`PR opened for #${a}`, () => prByHead(repoFull, headRef(a)));
  await until(`PR #${pr.number} CI green`, async () => prCi(await prByHead(repoFull, headRef(a))) === "ok");
  await until(
    `PR #${pr.number} approved`,
    async () => (await prByHead(repoFull, headRef(a))).reviewDecision === "APPROVED",
  );
  await until(`PR #${pr.number} merged`, async () => (await prByHead(repoFull, headRef(a))).state === "MERGED");
  await until(`issue #${a} closed`, async () => (await issueView(repoFull, a)).state === "CLOSED");
  await until(`worker spawned for dependent issue #${b}`, () => ctx.sessions().then((all) => workerFor(all, b)));
}
