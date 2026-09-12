/**
 * The daemon guarantees the review account can read every registered repo.
 * `ensureReviewAccess` checks read access as the review account; when it is
 * missing it invites the account as a collaborator with push (primary
 * account) and accepts the pending invitation as the review account, then
 * rechecks. The two identities are two gh clients: the primary one carries
 * no token override, the review one carries the review token as GH_TOKEN.
 * A failed invite is reported, never thrown — the reconciler retries on the
 * next poll and gates the reviewer leg until access exists.
 */

import { errorMessage } from "@pideck/shared";

export interface ReviewAccessGh {
  /** True when this client's account can read the repo. */
  hasReadAccess(): Promise<boolean>;
  /** Invites `login` as a collaborator with push, as the primary account. */
  inviteCollaborator(login: string): Promise<void>;
  /** Accepts this account's pending repository invitations. */
  acceptInvitations(): Promise<number>;
}

export type ReviewAccess = { ok: true } | { ok: false; detail: string };

export interface ReviewAccessInput {
  /** The primary-account client that issues the collaborator invite. */
  primary: Pick<ReviewAccessGh, "inviteCollaborator">;
  /** The review-account client; null when the review leg is off. */
  review: Pick<ReviewAccessGh, "hasReadAccess" | "acceptInvitations"> | null;
  reviewLogin: string | null;
  repo: string;
}

export async function ensureReviewAccess(input: ReviewAccessInput): Promise<ReviewAccess> {
  const { primary, review, reviewLogin, repo } = input;
  if (review === null || reviewLogin === null) return { ok: true };
  if (await review.hasReadAccess()) return { ok: true };
  try {
    await primary.inviteCollaborator(reviewLogin);
    await review.acceptInvitations();
  } catch (err) {
    const cause = errorMessage(err);
    return {
      ok: false,
      detail: `review account has no access to ${repo} — invite failed: ${cause}`,
    };
  }
  if (await review.hasReadAccess()) return { ok: true };
  return { ok: false, detail: `review account has no access to ${repo}` };
}