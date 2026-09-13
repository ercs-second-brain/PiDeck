import {
  assignIssue,
  createIssue,
  issueGhId,
  issueView,
  linkBlockedBy,
  prByHead,
  prCi,
  setIssueBody,
} from "../lib/gh.mjs";
import { live, workerFor } from "../lib/views.mjs";

/**
 * restart — reconciliation over events: seed the same shape as happy-path
 * (a fix + a dependent), let the loop run until the PR is opened, kill the
 * daemon and start it again on the untouched state dir, then assert on
 * /api/sessions that the live inventory is unchanged (same session ids,
 * watermarks intact, nothing owns an issue or PR twice) and on GitHub
 * facts that the loop resumed and completes.
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

/** Watermarks + counters that must survive a restart unchanged. */
function watermark(view) {
  const s = view.session;
  return {
    lastPromptedHeadSha: s.lastPromptedHeadSha,
    lastDeliveredIssueCommentId: s.lastDeliveredIssueCommentId,
    lastDeliveredPrCommentId: s.lastDeliveredPrCommentId,
    lastDeliveredReviewId: s.lastDeliveredReviewId,
    fixAttempts: s.fixAttempts,
  };
}

/** What a live session may own exclusively: its persona on an issue/PR. */
function inventoryKey(view) {
  const s = view.session;
  return `${s.persona}#${s.issueNumber ?? ""}/${s.prNumber ?? ""}`;
}

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
  const pr = await until(`PR opened for #${a}`, () => prByHead(repoFull, headRef(a)));

  const beforeLive = live(await ctx.allSessions());
  await ctx.restart();
  const afterLive = live(await ctx.allSessions());

  const beforeIds = beforeLive.map((v) => v.session.id);
  const afterIds = afterLive.map((v) => v.session.id);
  if (new Set(afterIds).size !== afterIds.length) {
    throw new Error(`restart: duplicate live session records — [${afterIds.join(", ")}]`);
  }
  if (afterIds.length !== beforeIds.length || afterIds.some((id) => !beforeIds.includes(id))) {
    throw new Error(
      `restart: live session inventory changed — before [${beforeIds.join(", ")}] after [${afterIds.join(", ")}]`,
    );
  }
  for (const v of afterLive) {
    const w = beforeLive.find((x) => x.session.id === v.session.id);
    if (w === undefined) continue;
    if (JSON.stringify(watermark(w)) !== JSON.stringify(watermark(v))) {
      throw new Error(`restart: watermarks on session ${v.session.id.slice(0, 8)} were not preserved`);
    }
  }
  const owners = new Set(afterLive.map(inventoryKey));
  if (owners.size !== afterLive.length) throw new Error("restart: two live sessions own the same issue/PR");
  console.log(
    `[e2e] restart: ${afterLive.length} live sessions reconnected, watermarks intact — ` +
    `resuming (once-per-head notices may repeat at most once by design)`,
  );

  await until(`PR #${pr.number} CI green after restart`, async () =>
    prCi(await prByHead(repoFull, headRef(a))) === "ok");
  await until(
    `PR #${pr.number} approved`,
    async () => (await prByHead(repoFull, headRef(a))).reviewDecision === "APPROVED",
  );
  await until(`PR #${pr.number} merged`, async () => (await prByHead(repoFull, headRef(a))).state === "MERGED");
  await until(`issue #${a} closed`, async () => (await issueView(repoFull, a)).state === "CLOSED");
  await until(`worker spawned for dependent issue #${b}`, () => ctx.sessions().then((all) => workerFor(all, b)));
}
