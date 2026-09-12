import { describe, expect, it } from "vitest";
import { ensureReviewAccess } from "./reviewAccess.js";

/** One gh client fake per identity; records the calls made through it. */
function fakeClient(options: {
  canRead?: boolean;
  failInvite?: boolean;
  failAccept?: boolean;
}): { calls: string[]; client: Reviewable } {
  const calls: string[] = [];
  return {
    calls,
    client: {
      async hasReadAccess() {
        calls.push("hasReadAccess");
        return options.canRead ?? false;
      },
      async inviteCollaborator(login) {
        calls.push(`invite:${login}`);
        if (options.failInvite) throw new Error("invite rejected");
      },
      async acceptInvitations() {
        calls.push("accept");
        if (options.failAccept) throw new Error("accept failed");
        return 1;
      },
    } satisfies Reviewable,
  };
}

type Reviewable = {
  hasReadAccess(): Promise<boolean>;
  inviteCollaborator(login: string): Promise<void>;
  acceptInvitations(): Promise<number>;
};

describe("ensureReviewAccess", () => {
  it("passes without a review account — the review leg is off", async () => {
    const primary = fakeClient({});
    const result = await ensureReviewAccess({
      primary: primary.client,
      review: null,
      reviewLogin: null,
      repo: "acme/widget",
    });
    expect(result).toEqual({ ok: true });
    expect(primary.calls).toEqual([]);
  });

  it("passes when the review account can already read the repo", async () => {
    const primary = fakeClient({});
    const review = fakeClient({ canRead: true });
    const result = await ensureReviewAccess({
      primary: primary.client,
      review: review.client,
      reviewLogin: "review-bot",
      repo: "acme/widget",
    });
    expect(result).toEqual({ ok: true });
    expect(primary.calls).toEqual([]);
    expect(review.calls).toEqual(["hasReadAccess"]);
  });

  it("invites with push and accepts the invitation when access is missing", async () => {
    // First check fails, the recheck after the invite succeeds.
    let canRead = false;
    const primary = fakeClient({});
    const review = fakeClient({});
    review.client.hasReadAccess = async () => {
      review.calls.push("hasReadAccess");
      return canRead;
    };
    review.client.acceptInvitations = async () => {
      review.calls.push("accept");
      canRead = true;
      return 1;
    };
    const result = await ensureReviewAccess({
      primary: primary.client,
      review: review.client,
      reviewLogin: "review-bot",
      repo: "acme/widget",
    });
    expect(result).toEqual({ ok: true });
    expect(primary.calls).toEqual(["invite:review-bot"]);
    expect(review.calls).toEqual(["hasReadAccess", "accept", "hasReadAccess"]);
  });

  it("reports no access when the invite cannot be completed", async () => {
    const primary = fakeClient({ failInvite: true });
    const review = fakeClient({});
    const result = await ensureReviewAccess({
      primary: primary.client,
      review: review.client,
      reviewLogin: "review-bot",
      repo: "acme/widget",
    });
    expect(result).toEqual({
      ok: false,
      detail: "review account has no access to acme/widget — invite failed: invite rejected",
    });
  });

  it("reports no access when the invitation never grants read access", async () => {
    const primary = fakeClient({});
    const review = fakeClient({});
    const result = await ensureReviewAccess({
      primary: primary.client,
      review: review.client,
      reviewLogin: "review-bot",
      repo: "acme/widget",
    });
    expect(result).toEqual({ ok: false, detail: "review account has no access to acme/widget" });
    expect(review.calls).toEqual(["hasReadAccess", "accept", "hasReadAccess"]);
  });
});