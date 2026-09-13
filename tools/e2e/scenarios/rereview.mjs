import {
  assignIssue,
  createIssue,
  issueView,
  prByHead,
  prCi,
  prReviewComments,
  prReviews,
  setIssueBody,
} from "../lib/gh.mjs";
import { orchestratorFor, reviewerFor, workerFor } from "../lib/views.mjs";

/**
 * rereview — the post-approval loop: the reviewer approves with an inline
 * comment, the worker addresses it and pushes, the reviewer is re-armed
 * (still live) and re-approves at the new head, and only then does the
 * orchestrator get the approved-and-green notice and merge. Asserts on
 * GitHub facts plus the daemon's session traces (`/api/sessions/:id/trace`),
 * because the hold and the re-review arm are delivery facts, not GitHub
 * ones. The fixture's `docs/REVIEW.md` steers the reviewer to leave exactly
 * one non-blocking note on the first approval and approve plain once it is
 * addressed.
 */

const fixBody = (n) => `## Task

\`test/greeting.test.js\` is failing on main because \`src/greeting.js\` still returns
\`"TODO"\`. Implement \`greeting()\` so the test passes. The wording is the product's:
\`Hello, PiDeck!\`.

## Review protocol

The repo's reviewers follow \`docs/REVIEW.md\`: their first approving review carries one
non-blocking inline note on \`src/greeting.js\`. When it arrives, address it with a commit
— add the comment the note asks for and push to this branch — and then reply in the
review thread (\`pideck reply\`) pointing at what you pushed. Push before replying, so
the reviewer re-reviews the fixed head.

Open a PR from \`pideck/issue-${n}\` with \`Closes #${n}\`.
`;

const headRef = (n) => `pideck/issue-${n}`;

const isDelivery = (entry, text) => entry.kind === "delivery" && (entry.text ?? "").includes(text);
const reviewChangesSent = (entries) => entries.some((e) => isDelivery(e, "New review activity on PR #"));
const reReviewSent = (entries) => entries.some((e) => isDelivery(e, "New head on PR #"));
const approvedGreenEntries = (entries) => entries.filter((e) => isDelivery(e, "approved and green"));

export async function run(ctx) {
  const { until, repoFull, primary, allSessions, trace } = ctx;

  const a = await createIssue(repoFull, { title: "Implement greeting()", body: fixBody("n") });
  await setIssueBody(repoFull, a, fixBody(a));
  await assignIssue(repoFull, a, primary);

  await until(`worker spawned for issue #${a}`, () => ctx.sessions().then((all) => workerFor(all, a)));
  const pr = await until(`PR opened for #${a}`, () => prByHead(repoFull, headRef(a)));
  await until(`PR #${pr.number} CI green`, async () => prCi(await prByHead(repoFull, headRef(a))) === "ok");
  await until(`reviewer spawned for PR #${pr.number}`, async () => {
    const r = reviewerFor(await allSessions(), pr.number);
    return r !== null && r.session.archivedAt === undefined;
  });

  const firstReview = await until(
    `reviewer approves PR #${pr.number} with an inline comment`,
    async () => {
      const [reviews, comments] = await Promise.all([
        prReviews(repoFull, pr.number),
        prReviewComments(repoFull, pr.number),
      ]);
      return reviews.find((r) => r.state === "APPROVED" && comments.some((c) => c.reviewId === r.id)) ?? false;
    },
  );
  const head1 = firstReview.commitId;

  // The hold: reviewChanges is out to the worker and the worker has not
  // answered yet, so the orchestrator must have no approved-green notice.
  await until(
    `worker holds reviewChanges for PR #${pr.number} with no approvedGreen to the orchestrator`,
    async () => {
      const all = await allSessions();
      const w = workerFor(all, a);
      if (w === null) return false;
      if (!reviewChangesSent((await trace(w.session.id)).entries)) return false;
      const answered = (await prReviewComments(repoFull, pr.number)).some((c) => c.author === primary);
      if (answered) return false;
      const o = orchestratorFor(all);
      if (o === null) return false;
      return approvedGreenEntries((await trace(o.session.id)).entries).length === 0;
    },
  );

  const head2 = await until(`worker pushes a new head on PR #${pr.number}`, async () => {
    const current = await prByHead(repoFull, headRef(a));
    return current !== null && current.headRefOid !== head1 ? current.headRefOid : false;
  });
  await until(`reviewer stays live and is re-armed for ${head2.slice(0, 7)}`, async () => {
    const r = reviewerFor(await allSessions(), pr.number);
    if (r === null || r.session.archivedAt !== undefined) return false;
    return reReviewSent((await trace(r.session.id)).entries);
  });
  await until(`reviewer re-approves at ${head2.slice(0, 7)}`, async () => {
    const reviews = await prReviews(repoFull, pr.number);
    return reviews.some((r) => r.state === "APPROVED" && r.commitId === head2 && r.id > firstReview.id);
  });
  await until(`approvedGreen delivered once for ${head2.slice(0, 7)}`, async () => {
    const o = orchestratorFor(await allSessions());
    if (o === null) return false;
    return approvedGreenEntries((await trace(o.session.id)).entries).length === 1;
  });

  await until(`PR #${pr.number} merged`, async () => (await prByHead(repoFull, headRef(a))).state === "MERGED");
  await until(`worker and reviewer archived in the same tick`, async () => {
    const all = await allSessions();
    const w = workerFor(all, a);
    const r = reviewerFor(all, pr.number);
    if (w === null || r === null) return false;
    if (w.session.archivedAt === undefined || r.session.archivedAt === undefined) return false;
    return Math.abs(Date.parse(w.session.archivedAt) - Date.parse(r.session.archivedAt)) <= 5_000;
  });
  await until(`issue #${a} closed`, async () => (await issueView(repoFull, a)).state === "CLOSED");
}