/**
 * Tests for `GET /api/gh-auth` (webapp onboarding wizard's gh permission
 * probe). Hermetic: GhClient runs over an in-memory GhRunner.
 */

import { describe, expect, it } from "vitest";
import type { GhRunner } from "../github/gh.js";
import { GhClient } from "../github/gh.js";
import { ghAuthPayload } from "./gh-auth.js";

function ghRunner(response: { status?: string; headers?: string; body: string } | { fail: string }): GhRunner {
  return async (args) => {
    if (args[0] === "api" && args[1] === "-i" && args[2] === "/user") {
      if ("fail" in response) throw new Error(response.fail);
      const headers = response.headers ?? "";
      return { stdout: `${response.status ?? "HTTP/1.1 200 OK"}\n${headers}\n\n${response.body}`, stderr: "" };
    }
    throw new Error(`fake gh: unexpected args ${args.join(" ")}`);
  };
}

describe("ghAuthPayload", () => {
  it("reports auth status and repo-creation permission for a scoped classic token", async () => {
    const gh = new GhClient(
      ghRunner({ headers: "x-oauth-scopes: repo, read:org", body: JSON.stringify({ login: "octocat" }) }),
    );
    const payload = await ghAuthPayload(gh);
    expect(payload).toEqual({
      authenticated: true,
      login: "octocat",
      tokenSource: "gh hosts.yml",
      scopes: ["repo", "read:org"],
      canCreateRepos: "yes",
      canCreatePrivateRepos: "yes",
      canCreatePublicRepos: "yes",
      detail: expect.stringContaining("repo"),
    });
  });

  it("reports public-only permission for a public_repo token", async () => {
    const gh = new GhClient(ghRunner({ headers: "x-oauth-scopes: public_repo", body: JSON.stringify({ login: "octocat" }) }));
    const payload = await ghAuthPayload(gh);
    expect(payload.canCreatePrivateRepos).toBe("no");
    expect(payload.canCreatePublicRepos).toBe("yes");
    expect(payload.canCreateRepos).toBe("no");
  });

  it("degrades to unauthenticated when the gh probe fails", async () => {
    const gh = new GhClient(ghRunner({ fail: "gh: not logged in" }));
    const payload = await ghAuthPayload(gh);
    expect(payload.authenticated).toBe(false);
    expect(payload.login).toBeNull();
    expect(payload.canCreateRepos).toBe("no");
    expect(payload.detail).toContain("not authenticated");
  });
});
